/* Shelly script to intelligently shed loads on a multi-channel switch.

Device: Pro4PM 1.4.4| 679fcca9

## Use Case

A "software circuit breaker": four loads are connected to each channel of a
Pro4PM; one is the primary load that ideally would never be disconnected, the
other three are lower priority and idle _most_ of the time. The circuit the
Pro4PM is downstream of does not have sufficient capacity to handle all four
loads on at "full bore" at the same time, and in the extreme can only supply the
primary load. However most of the time, the sum of the loads is well under the
circuit capacity so most of the time, all four can happily operate.

In numbers (all on a nominal 230V system):
- the upstream circuit breaker is rated to 16A
- the primary load (an outlet often connected to a caravan) varies from less
  than 0.5 to 8A, ~1-2A typical, but could in principle go to 15A
- the secondary loads are all water pumps: one that draws around 8A (a bore
  pump) and two that draw around 3-4A; there's no situation where more than one
  of these needs to be on at a time
- at most only the primary load, or primary load + one pump, should be on
 - note that in the worst case of the primary load reaching its maximum (15A)
   there is _no_ spare capacity for any of the pumps
- the task for this script is to manage the above so I don't have to ;-)
  - I could just let the circuit breaker "handle things" (as in, if the load
    becomes too high, the breaker will trip, but there are myriad problems with
    that approach; the breaker should only be relied upon as a safety net when
    the "smarts" fails)

- this script does not deal with re-enabling loads; the presumption is that
  they'll be turned back on manually or via timers/etc
  - turning loads back on automatically is troublesome as you'll need to ensure
    you can deal with the inevitable cycling that occurs; at a minimum some sort
    of hysteresis would be needed

- the Pro4PM has built-in software power/current limit controls but doesn't
  offer any coordination between switches (would be a nice additional feature to
  have this load-prioritisation function built-in, e.g. a "limit total load to X
  W/A" toggle, with the four channels listed in priority order)

## Script Design

1. tracks current out for all four switches in a global object that is updated as
   each new piece of information arrives via the various Shelly notifications (*)
2. posts a HTTP notification warning whenever more than one of the secondary
   loads is drawing any significant current
3. when the total current out exceeds a given threshold, selects one or more
   secondary loads to turn off (shed) such that the total should drop to below
   the limit

Working in current and not power as the limiting factor is, physically, current
draw (regardless of line voltage variations).

(*) the periodic `delta.aenergy` "hearbeats" are not useful here as they don't
report output status or current (only "accumulated? energy"); you could work
things out from that but it's simpler to just use the delta output and current
status notifications.

Aside on Low Power Loads
- as of 1.4.4, Shelly's current value is reported to two decimal places, with
  what appears to be 0.02A resolution; power is reported with one decimal place
  and (presumably) 0.1W resolution
  - at 230V, 0.02A is 4.6W, a significantly courser measure than the power
    resolution (i.e. ~50x difference)
  - the delta notifications only report _changes_: changes less than the
    resolution of the data field won't be 'seen' - for maximum resolution you'd
    want to ignore the reported current value and instead calculate the current
    from the measured power and voltage
    - corollary: for low power loads (under ~5W), the current will be considered
      "0" and unchanging (and thus, not reported)
  - for moderate loads (>10's of W), the above doesn't matter
*/

// configure these as desired:
// - switch IDs are 0-based (i.e. 0-3 for the Pro4PM) though they're labelled on
//   the device as 1-4
// - switchIds[] is in priority order: P0-P3, e.g. 1,3,0 means managing three
//   switches, with switch ID 1 (labelled 2 on the device) as the high-priority
//   ('always on') and switch ID 0 (label: 1) the first to be turned off
//   - if a switch is omitted it won't be considered in any part of the calcs
var CONFIG = {
  switchPriority: [3, 0, 1, 2], // switches to monitor
  currentMax: 15,               // aim to keep the sum total below this level
  httpNtfyURL: 'https://ntfy.sh/shelly-loadshed',
  httpNtfyHeaders: {            // static headers, incl. auth if required
    'Content-Type': 'text/plain',
    // title: placeholders will be replaced by values from deviceConfig
    'Title': '${deviceName}: ${scriptName}',  // see _replaceTemplate()
    'Tags': 'zap'
  },
  log: true       // enable/disable logging
}

// device info (config) incl. name (if not set, id) and switch names (labels) to use in
// the HTTP notification
// - script and switch names are only available via RPC;
//   Shelly.getdeviceConfig() returns some info (e.g. name), but not the rest
// - Shelly uses the term 'device info' for hardware and firmware information,
//   and 'device config' for user-configurable information
var deviceConfig = {
  // these will be replaced with actual names/labels (ref. getDeviceConfigThenInit)
  deviceName: 'Shelly Pro4PM',
  scriptName: 'Load Shed',
  switchNames: [ 'S1', 'S2', 'S3', 'S4']
}

// notifications for switch state changes (e.g. on/off, power) arrive
// independently and asynchronously; the state machine logic is greatly
// simplified by having all the necessary inputs in the one place/time
//
// this object is used to accumulate, via each Shelly notification, a complete
// view of the device's actual state as at the last change time
// - these arrays are in switch ID order, i.e. not switchPriority
//   iow, the output state of the 3rd-priority switch = output[switchPriority[2]]
var loadState = {
  current: [],  // last known `current` for each switch
  output: []    // ditto, for `output` (on/off)
}

// use uptime as the epoch (it's always available; unixtime requires NTP)
// - only updated in _notifyWrite(); will need to be updated more frequently
//   if used elsewhere
//   currentTime = Shelly.getComponentStatus('Sys').uptime;
//   https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Sys#status
var currentTime = 0;

// rate limit console.log messages to the given interval
var _logQueue = {
  queue: [],      // queued messages
  maxSize: 10,    // limit the size of the queue
  interval: 100   // interval (milliseconds)
}

// rate limit HTTP notifications to (approximately) the given interval
// the queue length here should be very small if you want to eliminate any
// potential for spamming the notification service
var _notifyQueue = {
  queue: [],          // queued messages
  maxSize: 5,         // limit the size of the queue
  interval: 20        // interval (seconds)
}

// dequeue one message; intended to be called via a Timer
var _lastNotificationTime = 0;
var _notificationIntervalCount = 0;
function _logWrite() {
  // Shelly doesn't do array.shift (!), splice instead
  if (_logQueue.queue.length > 0) {
    // include a 'tag' in the log messages for easier filtering
    console.log('[loadshed]', _logQueue.queue.splice(0, 1)[0]);
  }

  // piggyback notifications off this same timer, as needed
  // the count is an optimisation; no point calling _notifyWrite at 10Hz
  // waiting for a 20s interval to expire
  // - can't do a simple time check as don't want/need to update currentTime
  if (_notificationIntervalCount-- <= 0 && _notifyQueue.queue.length > 0) {
    _notifyWrite(true);
  }
}

function _log() {
  if (!CONFIG.log) return;
  if (_logQueue.queue.length < _logQueue.maxSize) {
    _logQueue.queue.push(arguments.join(' '));
  } else {
    console.log('_log: overflow!!'); // you may or may not actually get to see this
  }
}

// serve the HTTP notification queue (at a much lower rate than _logWrite)
// _notifyWrite and _logWrite 'cooperate' to share a timer; the latter invoking
// the former every _notificationIntervalCount iterations (and when there's
// something to do); _notificationIntervalCount is updated by _notifyWrite to
// keep it 'primed' for the minimum notification interval
function _notifyWrite(byTimer) {
  currentTime = Shelly.getComponentStatus('Sys').uptime;
  var remaining = _notifyQueue.interval - (currentTime - _lastNotificationTime);
  if (byTimer || remaining < 0) { // go, go gadget
    //_log('_notifyWrite by', (byTimer ? 'timer' : 'flush:' + remaining),
    //  'qlen=' + _notifyQueue.queue.length);
    // there shouldn't be a situation where we get here with an empty queue
    // but handle it anyway
    if (_notifyQueue.queue.length > 0) {
      postNotification(_notifyQueue.queue.splice(0, 1)[0]);
      _lastNotificationTime = currentTime;
      remaining = _notifyQueue.interval;
    }
  }

  // time remaining should be in the range [0, _notifyQueue.interval] (seconds)
  // (0 if we juuust missed sending a notification; _notifyQueue.interval if
  // we just sent one and now have to wait the full interval)
  // _notificationIntervalCountInterval is effectively the 'time' in increments
  // of _logQueue.interval until the next call; so convert time remaining to
  // counts
  var interval = Math.max(0, Math.min(remaining, _notifyQueue.interval));
  //_log('_notifyWrite', interval, 'qlen=' + _notifyQueue.queue.length);
  _notificationIntervalCount = interval*1000/_logQueue.interval;
}

var _lastNotificationMessage;
function _notify() {
  if (!CONFIG.httpNtfyURL) return;  // no-op if no notification URL

  // suppress duplicates; can't just peek at the queue as it may have been
  // serviced already
  var message = arguments.join(' ');
  if (message === _lastNotificationMessage) return;
  _lastNotificationMessage = message;

  // discard oldest messages to make room for new ones
  if (_notifyQueue.queue.length >= _notifyQueue.maxSize) {
    // delete the 0'th message, (attempt to) report it
    var m = _notifyQueue.queue.splice(0, 1)[0];
    _log('_notify overflow:', JSON.stringify(m));
  }
  _notifyQueue.queue.push(message);
  _notifyWrite(); // service the queue if possible (attempt a write 'asap'
}

function postNotification(message) {
  var params = {
    'method': 'POST',
    'url': CONFIG.httpNtfyURL,
    'headers': CONFIG.httpNtfyHeaders,
    'body': message,
    'timeout': 5
  }

  // have to use HTTP.Request to specify headers
  _log('postNotification [' + JSON.stringify(message) + ']');
  Shelly.call("HTTP.Request", params, _callbackLogError);
}

function _notnullish(v) {
  return v !== undefined && v !== null;
}

// helper to avoid barfing on a TypeError when object properties are missing
function _get(obj, path) {
  var parts = path.split('.');
  var current = obj;

  for (var i = 0; i < parts.length; i++) {
    if (current && current[parts[i]] !== undefined && current[parts[i]] !== null) {
      current = current[parts[i]];
    } else {
      return undefined;
    }
  }
  return current;
}

function _callbackLogError(result, errorCode, errorMessage) {
  if (errorCode != 0) {
    // not _log: always report actual errors (well, assuming not rate limited)
    console.log('call failed: ', errorCode, errorMessage);
  }
}

// 'sync' switch power (required when the script is starting up)
function _getloadState() {
  var status;
  // to kick off, populate loadState based on what's defined in switchPriority
  for (var i = 0; i < CONFIG.switchPriority.length; i++) {
    var switchId = CONFIG.switchPriority[i];
    status = Shelly.getComponentStatus('Switch', switchId);
    _log('_getloadState priority=' + i, 'sw ID=' + switchId,
        'status.current=' + status.current, 'status.output=' + status.output);
    loadState.current[switchId] = status.current;
    loadState.output[switchId] = status.output;
  }
}

function _updateLoadStatePower(notifyStatus) {
  var switchId = notifyStatus.id;
  var current = _get(notifyStatus, 'delta.current');
  //_log('_updateLoadStatePower', switchId, JSON.stringify(current));
  if (_notnullish(current)) {
    loadState.current[switchId] = current;
    // current measurement can have an offset error, not totally unexpected
    // for a device to be off yet still report a _small_ current; however
    // anything not-small is a problem
    if (current > 0.1 && !loadState.output[switchId]) {
      _log('WARN output', switchId, 'is off yet current='+current);
    }
  }
}

function _updateLoadStateOutput(notifyStatus) {
  var switchId = notifyStatus.id;
  var output = _get(notifyStatus, 'delta.output');
  //_log('_updateLoadStateOutput', switchId, JSON.stringify(output));
  if (_notnullish(output)) loadState.output[switchId] = output;
}

// warn on >2 devices being on at once
var _interlockNotificationPosted = false;
function _checkInterlock() {
  // counting the number of devices that are on (without =>):
  // loadState.output.filter(function(n) {return n !== 0}).length
  // but it'd be helpful to know _which_ switches were on...
  var switchesOn = [];
  for (var i = 0; i < loadState.output.length; i++) {
    // skip the primary as we don't care if it's on or not
    if (i == CONFIG.switchPriority[0]) continue;
    //_log('_checkInterlock', i, '=', loadState.output[i]);
    if (loadState.output[i]) switchesOn.push(i);
  }
  var switchNames = [];
  for (var i = 0; i < switchesOn.length; i++) {
    var switchId = switchesOn[i];
    switchNames.push(deviceConfig.switchNames[switchId] + ' (' + loadState.current[switchId] + 'A)');
  }
  //_log('_checkInterlock', switchesOn);
  if (switchesOn.length > 1) {
    _notify('Multiple secondary devices are on:', switchNames.join(', '));
    _interlockNotificationPosted = true;
  } else if (_interlockNotificationPosted) {
    _notify('Multiple secondary devices cleared; on:', switchNames.join(', '));
    _interlockNotificationPosted = false;
  }
}


function _sumCurrents() {
  var sum = 0;
  for (var i = 0; i < loadState.current.length; i++) {
    //_log('_sumCurrents', i, 'current=' + loadState.current[i]);
    sum += loadState.current[i];
  }
  return sum;
}

function _shedLoad(totalCurrent) {
  // load shedding is a non-trivial problem in the general case for a large
  // number of loads, as would be applied by an electricity supplier
  // for three loads it's much simpler; in the extreme you could simply specify
  // all the possible combinations in preferential order... (3 binary switches =
  // 2^3 = 8 combinations)
  // about the simplest and most "predictable" approach is just to start with
  // the lowest priority and keep turning them off until you're either under the
  // threshold, or you run out of devices to turn off ;-)

  // iterate through the switch priority list, from the end
  // load ID switchIds[0] is never on option (i.e. stop at p == 1)
  var hitlist = [];
  for (var p = CONFIG.switchPriority.length - 1; p > 0; p--) {
    if (totalCurrent < CONFIG.currentMax) {
      break; // job done
    } else {
      var switchId = CONFIG.switchPriority[p];
      _log('_shedLoad totalCurrent=' + totalCurrent, 'p=' + p, 'id=' + switchId);
      if (loadState.output[switchId]) { // on?
        hitlist.push(switchId);
        Shelly.call('Switch.Set', { id: switchId, on: false }, _callbackLogError);
        // assume it actually turned off and the load is gone
        totalCurrent -= loadState.current[switchId];
      }
    }
  }
  if (hitlist.length > 0) {
    var switchNames = [];
    for (var i = 0; i < hitlist.length; i++) {
      var switchId = hitlist[i];
      switchNames.push(deviceConfig.switchNames[switchId] + ' (' + loadState.current[switchId] + 'A)');
    }
    _notify('Shedding load: turned off switch(es)', switchNames.join(', '));
  }
}

function updateStatus(notifyStatus) {
  // ignore delta.aenergy updates; only want switches
  if (_notnullish(_get(notifyStatus, 'delta.aenergy'))) return;
  if (notifyStatus.name !== 'switch') return;

  //_log('updateStatus', JSON.stringify(notifyStatus));

  // pull out all available info
  _updateLoadStateOutput(notifyStatus);
  _updateLoadStatePower(notifyStatus);
  //_log('loadState', JSON.stringify(loadState));

  _checkInterlock();  // warn on >2 devices being on at once
  var totalCurrent = _sumCurrents();
  _log('doChecks', 'totalCurrent=' + totalCurrent);
  if (totalCurrent > CONFIG.currentMax) {
    _shedLoad(totalCurrent);
  }
}


/* ************************************************************************** */

// would like to have the device name and other details before kicking off
// - these are only available via (async) RPC
// init is split into two stages:
// 1 - make the asynchronous call and poll for it to complete
// 2 - called by stage 1; carry on with setup and kick off
// note that the _log queue does not kick off until step 2

var _gotDeviceConfig = false;
function _callbackGetConfig(result, errorCode, errorMessage) {
  _gotDeviceConfig = true;
  if (errorCode == 0) {
    // success, copy over the bits we want
    //console.log('_callbackGetConfig', JSON.stringify(result));
    // Logical OR assignment (||=) is ES12 (!)
    deviceConfig.deviceName = _get(result, 'sys.device.name') || deviceConfig.deviceName;
    deviceConfig.scriptName = _get(result, 'script:' + Shelly.getCurrentScriptId() + '.name') || deviceConfig.scriptName;
    for (var i = 0; i < CONFIG.switchPriority.length; i++) {
      var switchId = CONFIG.switchPriority[i];
      deviceConfig.switchNames[switchId] =
        _get(result, 'switch:' + switchId + '.name') || 'Switch ' + (switchId + 1);
    }
    //console.log('_callbackGetConfig:', JSON.stringify(deviceConfig));
  } else {
    console.log('WARN call failed: ', errorCode, errorMessage);
  }
}

function getDeviceConfigThenInit(poll) {
  if (!poll) {  // kick-off
    //console.log('getDeviceConfigThenInit call');
    Shelly.call("Shelly.GetConfig", null, _callbackGetConfig);
  }
  if (!_gotDeviceConfig) {  // waiting, waiting...
    //console.log('getDeviceConfigThenInit setting timer');
    Timer.set(200, false, getDeviceConfigThenInit, true); // non-repeating, userdata: poll=true
  } else {
    //console.log('getDeviceConfigThenInit done');
    init();
  }
}

// helper to sub in values from deviceConfig; note: no regexes in Shelly...
function _replaceTemplate(template, config) {
  var keys = Object.keys(config);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    template = template.replace('${' + key + '}', config[key]);
  }
  return template;
}

function init() {
  CONFIG.httpNtfyHeaders.Title =
    _replaceTemplate(CONFIG.httpNtfyHeaders.Title, deviceConfig);

  if (CONFIG.log) {
    // set up the log timer; this burns a relatively precious resource but
    // could easily be moved to an existing timer callback if needed
    Timer.set(_logQueue.interval, true, _logWrite);
  }

  // for the Pro4PM 1.4.4 at least, separate notifications are posted for each
  // channel, more or less at the same moment, every 60s (in no discernable
  // order); there's no point in doing all the checks four times, so instead
  // the status handler simply records the latest data, with the checks
  // executed via a separate periodic timer

  _getloadState();
  _log('loadState', JSON.stringify(loadState));
  Shelly.addStatusHandler(updateStatus);
  _notify('script start');
}

getDeviceConfigThenInit();
