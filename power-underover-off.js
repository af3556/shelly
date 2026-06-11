/* Shelly script to turn off an output when the load power is below, or above,
a given threshold for a given time period.

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

Notifications for switch state changes (e.g. on/off, power) arrive independently and
asynchronously; these are collected in the switchState object.
 - an alternative approach could just query all the necessary bits at some fixed interval but
   this is arguably simpler, is more efficient and responsive

This script:

1. tracks switch state in a global object that is updated as each new piece of
   information arrives via the various Shelly notifications
2. when the over/under trigger condition is met, starts a timer to turn the output off
  - timer is cleared whenever the trigger condition is cleared

*/

// trigger conditions (referenced in CONFIG below)
function overpower(power) { return power > CONFIG.threshold; }
function underpower(power) { return power < CONFIG.threshold; }

/*
Configure these as desired:
  - switch IDs are 0-based (i.e. 0-3 for the Pro4PM) though they're labelled on
    the device as 1-4
  - timeout: when the load power is below or above the threshold for longer than the given timeout
    period, the output is turned off
    - a timeout of 0 (turning off immediately the moment power crossed the threshold) works fine
      for overpower, but can be problematic for the underpower trigger: Shelly (usually) reports
      the power as 0 at the time the switch turns on; we can't ignore that entirely as the load may
      well stay 0
    - to mitigate this issue for underpower triggers there are two options: enable the holdoff
      option, _or_ simply use a sufficiently large timeout to allow your load to start up and for
      Shelly to report power (e.g. 30-60s should be safe)
      - holdoff will ignore the trigger until the second crossing; for the underpower trigger this
        means the load must go above the threshold before the trigger is armed; could be used for
        overpower too (armed only after going below threshold) but is probably not very useful there
*/

var CONFIG = {
  switchId: 3,    // switch to monitor
  threshold: 50,  // threshold (Watts)
  trigger: underpower, // trigger function
  timeout: 0,     // timeout (seconds) (0 = ASAP)
  holdoff: true,  // whether the threshold power level must be reached before considering the trigger
  log: true       // logging on/off
}

// this object is used to accumulate, via each Shelly notification, a complete
// view of the device's actual state
// - initialised in _getSwitchState
var switchState = {
  output: null,   // last known switch output State (true, false)
  power: null,    // last known power (number >= 0)
  held: null      // whether holdoff has been met (true, false)
}

var timerHandle = null; // timer callback handle

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

function _updateSwitchPower(notifyStatus) {
  // update switch state with current power
  // `delta.apower` notifications are sent on load changes _and_ switch output
  // state changes (even when power remains 0)
  var apower = _get(notifyStatus, 'delta.apower');
  if (!_notnullish(apower)) return;  // not a delta.apower update
  _log('_updateSwitchPower apower=', JSON.stringify(apower));

  switchState.power = apower;
}

function _updateSwitchOutput(notifyStatus) {
  // update switch state with current output state (on/off)
  var output = _get(notifyStatus, 'delta.output');
  if (!_notnullish(output)) return;  // not a delta.output update
  _log('_updateSwitchOutput output=', JSON.stringify(output));

  switchState.output = output;
}

function _timeoutHandler() {
  _log('_timeoutHandler: turning off');
  Shelly.call('Switch.Set', { id: CONFIG.switchId, on: false }, _callbackLogError);
}

function _statusHandler(notifyStatus) {
  // only interested in notifications regarding the specific switch
  if (notifyStatus.component !== 'switch:' + CONFIG.switchId) return;
  //_log(JSON.stringify(notifyStatus));

  // extract whatever's available in the notification
  _updateSwitchPower(notifyStatus);
  _updateSwitchOutput(notifyStatus);

  if (switchState.output) {
    if (CONFIG.trigger(switchState.power)) {
      // set the timer if not held off and one's not already running
      if (!switchState.held && !timerHandle) {
        _log('timer set: ' + CONFIG.timeout);
        timerHandle = Timer.set(CONFIG.timeout*1000, false, _timeoutHandler);
      }
    } else {
      switchState.held = false;
      if (Timer.clear(timerHandle)) _log('timer cleared');
      timerHandle = null;
    }
  }
  else
    switchState.held = CONFIG.holdoff;  // reset holdoff
}

function _initSwitchState() {
  var status = Shelly.getComponentStatus('Switch', CONFIG.switchId);
  _log('_getSwitchState status=', JSON.stringify(status));
  if (!status) {
    console.log('_getSwitchState: failed to get status for switch ' + CONFIG.switchId);
    return false;
  }
  switchState.output = status.output;
  switchState.power = status.apower;
  // the output may already be on at script start; holdoff still applies
  switchState.held = CONFIG.holdoff;
  _log(JSON.stringify(switchState));
  return true;
}

function init() {
  if (CONFIG.log) {
    // set up the log timer; this burns a relatively precious resource but
    // could easily be moved to an existing timer callback
    Timer.set(_logQueue.interval, true, _logWrite);
  }

  // when the script starts up with a constant load output (incl. 0), we won't see any
  // `delta.output` or `delta.apower` notifications (only hearbeats); have to manually get the
  // current state to ensure we have a sane initial state
  // - if the initial get state fails, we're done
  if (_initSwitchState())
      Shelly.addStatusHandler(_statusHandler);
  else
      _log('_initSwitchState failed, not running');
}

init();
