/* Shelly script to turn off an output when the load power is below a given
threshold for a given time period.

Device: Pro4PM 1.4.4| 679fcca9

## Use Cases

This script was created to turn a regular pressure-controlled water pump into a
"one-shot" pump - one that turns off and stays off shortly after the high
pressure level is reached. This is being used to transfer water from one tank to
another, where the destination tank has a float valve that closes when it is
full. The goal is to (manually at this point) turn the pump on when required and
then not have to keep a close eye on it from there on. The water pump has a
built-in pressure switch that turns the pump off when a certain water pressure
is reached and back on when pressure falls below a lower threshold. This is
ideal behaviour to feed a water tap (spigot, faucet, outlet), however for my use
case (transferring water between tanks) once the pressure cutoff is reached [the
pump's job is done](https://www.youtube.com/watch?v=Kmu_UVgk2ZA&t=367s) until
restarted at some much later time. Ideally the water would stay pressurised for
arbitrarily long periods of time and thus the pump's lower pressure limit never
reached and the pump would stay off of its own accord - however it turns out
real-world one-way / non-return valves do not always behave as they are named
and the pump cycles every 10-20 minutes.

A simple off-timer could be used to shut the pump power off after some fixed
time, however the time taken for the pump to do its work can vary quite
substantially and the pump may either be cut short or will needlessly cycle once
it hits its pressure limit. Also, where's the fun in that? Instead, this script
is used to monitor the pump's energy use and when it drops to some low value (a
proxy for the pump having completed its work for now), turns power to the pump
off.

A simpler use case could be a machine that for safety reasons it is desired to
also turn off the outlet once the machine itself has been turned off / stopped.

Ref. https://af3556.github.io/posts/shelly-scripting-part1/

## Script Design

This script:

1. tracks switch state in a global object that is updated as each new piece of
   information arrives via the various Shelly notifications
   - including recording the time of entering 'idle state'
2. turns the output off when the idle state and timeout conditions are met

*/

// configure these as desired:
// - switch IDs are 0-based (i.e. 0-3 for the Pro4PM) though they're labelled on
//   the device as 1-4
// - timeout: when the load power drops below the threshold for longer than the timeout, the load
//   is considered idle and the output turned off; note the timer is reset every time the output
//   is switched on or load rises above the threshold
// - ("usually" in the following means as observed, but not documemnted as such)
// - a timeout of 0 (turning off immediately the moment power drops below threshold) is problematic
//   as Shelly (usually) reports the switch turning on and the load current as two separate events
//   ((usually) with switch state first), the moment a switch is turned on the load is likely to be
//   reported in that notification as 0; have to defer the "is idle" decision until after at least
//   one power notification has arrived after a switch on
var CONFIG = {
  switchId: 3,    // switch to monitor
  threshold: 50,  // idle threshold (Watts)
  timeout: 0,     // timeout (seconds) (0 = ASAP)
  log: true       // enable/disable logging
}



// notifications for switch state changes (e.g. on/off, power) arrive
// independently and asynchronously; the state machine logic is greatly
// simplified by having all the necessary inputs in the one place/time
//
// this object is used to accumulate, via each Shelly notification, a complete
// view of the device's actual state as at the last change time
// - an alternative approach could just query all the necessary bits every
//   callback, but where's the fun in that #efficiency
// - state initialised in _getSwitchState
var switchState = {
  output: null,   // last known switch output State (true, false)
  idle: null,     // last known idle (apower < threshold) (true, false)
  transitionTime: null   // timestamp of last idle transition
}

// use uptime as the epoch (it's always available; unixtime requires NTP)
var currentTime = 0;

// rate limit console.log messages to the given interval
var _logQueue = {
  queue: [],      // queued messages
  maxSize: 20,    // limit the size of the queue
  interval: 100   // interval, ms
}

// dequeue one message; intended to be called via a Timer
function _logWrite() {
  // Shelly doesn't do array.shift (!), splice instead
  if (_logQueue.queue.length > 0) {
    // include a 'tag' in the log messages for easier filtering
    console.log('[underpower-off]', _logQueue.queue.splice(0, 1)[0]);
  }
}

function _log() {
  // Shelly doesn't support the spread operator `...`
  // workaround: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/arguments
  if (!CONFIG.log) return;
  if (_logQueue.queue.length < _logQueue.maxSize) {
    _logQueue.queue.push(arguments.join(''));
  } else {
    console.log('_log: overflow!!'); // you may or may not actually get to see this
  }
}

function _notnullish(v) {
  return v !== undefined && v !== null;
}

/*
Whee javascript... definitely a good idea to avoid attempting to deference
a non-existent property - doing so will kill the script and it'll not
automatically restart
 - ES6 addresses this problem w/ 'optional chaining' (?.) operator
 - this ain't ES6
A simple one-liner would normally suffice:
 return path.split('.').reduce((o, p) -> (typeof o === 'undefined' || o === null ? o : o[p]), obj);
however Shelly's Array object has been neutered of the .reduce() function.
*/
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
    // not _log: always report actual errors
    console.log('call failed: ', errorCode, errorMessage);
  }
}

// update switch state with current power
function _updateSwitchIdle(notifyStatus) {
  // `delta.apower` notifications are sent on load changes _and_ switch output
  // state changes (even when power remains 0)
  var apower = _get(notifyStatus, 'delta.apower');
  if (!_notnullish(apower)) return;  // not a delta.apower update
  _log('_updateSwitchIdle apower=', JSON.stringify(apower));

  var idle = apower < CONFIG.threshold;

  // no change, then nothing to do
  if (switchState.idle === idle) return;

  _log('_updateSwitchIdle changed, idle=', idle);

  // it may be tempting to force the output state here to be on if apower > 0, however risks
  // falsely claiming the output is on when we may just be receiving a (late) apower update
  // after the switch has been turned off

  switchState.idle = idle;
  switchState.transitionTime = currentTime;
}

// update switch state with current output state (on/off); takes priority over _updateSwitchIdle
function _updateSwitchOutput(notifyStatus) {
  var output = _get(notifyStatus, 'delta.output');
  if (!_notnullish(output)) return;  // not a delta.output update
  _log('_updateSwitchOutput output=', JSON.stringify(output));

  // no change, then nothing to do
  if (switchState.output === output) return;

  _log('_updateSwitchOutput changed');  // output reported above

  // though the load may actually be < threshold (incl. 0) we won't know for sure until receiving
  // an apower update, in the meantime "turned on" means - by definition - not-idle (and for 
  // completeness, turned off means idle)
  switchState.idle = !output;

  switchState.output = output;
  switchState.transitionTime = currentTime;
}

function _isTimeExpired() {
  return currentTime - switchState.transitionTime >= CONFIG.timeout;
}


function statusHandler(notifyStatus) {
  // only interested in notifications regarding the specific switch
  if (notifyStatus.component !== 'switch:' + CONFIG.switchId) return;
  //_log(JSON.stringify(notifyStatus));

  // https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Sys#status
  // use uptime and not unixtime; the latter won't be available without NTP
  currentTime = Shelly.getComponentStatus('Sys').uptime;

  // extract whatever's available in the notification
  // - the notification will be _one of_: an `output` notification, an `apower`
  //   notification, or 'something else' (e.g. heartbeat)
  // - some notifications may include both switch `output` and `apower` info
  //   (e.g. when a switch is turned on), this could be leveraged to eliminate
  //   some processing but we'll KISS
  _updateSwitchIdle(notifyStatus);
  _updateSwitchOutput(notifyStatus); // may also update idle; priority over _updateSwitchIdle

  if (switchState.output) {
    _log('on idle=', switchState.idle, ' dt=', currentTime - switchState.transitionTime);
    if (switchState.idle && _isTimeExpired()) {
      _log('idle and timer expired: turning off');
      Shelly.call('Switch.Set', { id: CONFIG.switchId, on: false }, _callbackLogError);
    }
  }
  _log(JSON.stringify(switchState));
}

// initialise switch state; called when the script is starting up with a constant load (incl. 0)
function _getSwitchState() {
  var status = Shelly.getComponentStatus('Switch', CONFIG.switchId);
  _log('_getSwitchState status=', JSON.stringify(status));
  if (!status) {
    console.log('_getSwitchState: failed to get status for switch ' + CONFIG.switchId);
    return false;
  }
  switchState.output = status.output;
  switchState.idle = status.apower < CONFIG.threshold;
  switchState.transitionTime = currentTime;
  return true;
}

function init() {
  if (CONFIG.log) {
    // set up the log timer; this burns a relatively precious resource but
    // could easily be moved to an existing timer callback
    Timer.set(_logQueue.interval, true, _logWrite);
  }

  currentTime = Shelly.getComponentStatus('Sys').uptime;

  // when the script starts up with a constant load output (incl. 0), we won't see any
  // `delta.output` or `delta.apower` notifications (only hearbeats); have to manually get the
  // current state to ensure we have a sane initial state
  // - if the initial get state fails, we're done
  if (_getSwitchState()) Shelly.addStatusHandler(statusHandler);
}

init();
