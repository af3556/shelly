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
// - a timeout of 0 would technically not work: Shelly reports the switch
//   turning on and the load current as two separate events (which switch state
//   first), so the moment a switch is turned the load is likely to be zero; the
//   fix is to defer the decision until after at least one power notification
//   has arrived (i.e. when we do have all the necessary info)
//   - this is represented as an output state of 'waiting'
//   - an alternative approach would be to just hard-code a minimum period but
//     there's no guarantee when a power update will arrive and it's usually
//     >7-8s for the Pro4PM
var CONFIG = {
  switchId: 0,    // switch to monitor
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
var switchState = {
  output: null,   // last known switch output State (null, true, false, 'waiting')
  apower: 0,      // last known `apower` reading
  timer: 0        // timestamp of last on or idle transition
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
    _logQueue.queue.push(arguments.join(' '));
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

// 'init' switch state when the script is starting up with no or constant load,
// where statusHandler hasn't been called for the switch yet
function _getSwitchState() {
  var status = Shelly.getComponentStatus('Switch', CONFIG.switchId);
  _log('_getSwitchState status=', JSON.stringify(status));
  switchState.output = status.output;
  switchState.apower = status.apower;
  switchState.timer = currentTime;
}

// update switch state with current output state (on/off)
function _updateSwitchOutput(notifyStatus) {
  var output = _get(notifyStatus, 'delta.output');
  if (!_notnullish(output)) return;  // not a delta.output update
  _log('_updateSwitchOutput output=', JSON.stringify(output));

  // !== true is not necessarily === false (e.g. on init, where output is null);
  // just want to determine a _change_
  if (switchState.output !== output) {    // an edge transition
    // reset the timer when turning on ('on/off edge transition')
    if (output === true) {  // was off, now on
      _log('_updateSwitchOutput reset timer (and waiting for power update)');
      switchState.timer = currentTime;
      output = 'waiting'; // await an apower notification
    }
  }
  switchState.output = output;
}

// update switch state with current power
function _updateSwitchPower(notifyStatus) {
  // `delta.apower` notifications are sent on load changes _and_ switch output
  // state changes (even when power remains 0)
  var apower = _get(notifyStatus, 'delta.apower');
  if (!_notnullish(apower)) return;  // not a delta.apower update
  _log('_updateSwitchPower apower=', JSON.stringify(apower));
  var idlePrev = _isPowerIdle();
  switchState.apower = apower;

  if (_isPowerIdle() !== idlePrev) {   // an edge transition
    if (idlePrev === false) {
      // reset the idle timer on transition from not-idle to idle
      _log('_updateSwitchPower reset timer');
      switchState.timer = currentTime;
    } else {
      _log('_updateSwitchPower no longer waiting');
      switchState.output = true; // would have been 'waiting'
    }
  }
}

function _isTimeExpired() {
  return currentTime - switchState.timer >= CONFIG.timeout;
}
function _isPowerIdle() {
  return switchState.apower < CONFIG.threshold;
}


function statusHandler(notifyStatus) {
  // only interested in notifications regarding the specific switch
  if (notifyStatus.component !== 'switch:' + CONFIG.switchId) return;
  //_log(JSON.stringify(notifyStatus));

  // https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Sys#status
  // use uptime and not unixtime; the latter won't be available without NTP
  currentTime = Shelly.getComponentStatus('Sys').uptime;

  // the notification will be _one of_: an `output` notification, an `apower`
  // notification, or 'something else'
  // - some notifications may include both switch `output` and `apower` info
  //   (e.g. when a switch is turned on), this could be leveraged to eliminate
  //   some processing but for the sake of simplicity we'll KISS
  _updateSwitchPower(notifyStatus);
  _updateSwitchOutput(notifyStatus);

  switch (switchState.output) { // JS switch uses strict equality
    case true:  // on
      _log('on p=', switchState.apower, ' dt=', currentTime - switchState.timer);
      if (_isPowerIdle() && _isTimeExpired()) {
        _log('idle, timer expired: turning off');
        Shelly.call('Switch.Set', { id: CONFIG.switchId, on: false }, _callbackLogError);
      }
      break;
    case 'waiting':
      // fall through
    case false: // off; nothing to do
      break;
    default:
      // when the script starts up with a constant load output (incl. 0), we won't
      // see any `delta.output` or `delta.apower` notifications (only
      // hearbeats), have to "manually" get the current state
      // this should happen only once; no need to invoke on every iteration
      _getSwitchState();
  }
  _log(JSON.stringify(switchState));
}

function init() {
  if (CONFIG.log) {
    // set up the log timer; this burns a relatively precious resource but
    // could easily be moved to an existing timer callback
    Timer.set(_logQueue.interval, true, _logWrite);
  }
  Shelly.addStatusHandler(statusHandler);
}

init();
