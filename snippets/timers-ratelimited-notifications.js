/* Shelly script to demonstrate using Timers for rate limited notifications to
a HTTP endpoint (webhook).

Device: Pro4PM 1.4.4| 679fcca9
*/

// ntfy.sh is a neat, simple HTTP-based pub-sub notification service
var CONFIG = {
  httpNtfyURL: 'https://ntfy.sh/',  // topic will be appended
  httpNtfyHeaders: {
    // any static headers required by the webhook, incl. auth if required
    'Title': 'Ping!',
    'Tags': 'smiley'
  }
}

/*** queue ***/

// rate limit HTTP notifications to (approximately) the given interval
// the queue length here should be very small if you want to eliminate any
// potential for spamming the notification service
var _notifyQueue = {
  queue: [],          // queued messages
  maxSize: 5,         // limit the size of the queue
  interval: 10        // minimum interval (seconds)
}

// dequeue one notification and if necessary schedule the next one-shot timer
var _lastMessageTime = 0;
var _timerHandle = null;
function _notifyWrite(byTimer) {
  // aside: this function can be called _either_ as a Timer callback or directly
  // via _notify() (a "flush"); ES5 is single threaded so only one _or_ the
  // other should be in play at any given invocation
  // it's unclear what guarantees Shelly's Timer provides around timing of a
  // callback: it may well be possible that a callback is called prematurely
  // i.e. where _notifyQueue.interval - (t - _lastMessageTime) > 0
  // to sidestep that entire problem the byTimer argument is used and set true
  // (only) when called via Timer

  // there are no console.log() calls in the 'fallthrough' path here; _notify()
  // (and hence _notifyWrite()) may well be called quite frequently; be aware
  // that some logs will be discarded if console.log() is called "too
  // frequently"

  // use uptime and not unixtime; the latter won't be available without NTP
  var t = Shelly.getComponentStatus('Sys').uptime;
  // how long is left to wait?
  var remaining = _notifyQueue.interval - (t - _lastMessageTime);

  if (byTimer || remaining < 0) { // go, go gadget
    //console.log('_notifyWrite by', (byTimer ? 'timer' : 'flush:' + remaining),
    //  'qlen=' + _notifyQueue.queue.length);
    // there shouldn't be a situation where we get here with an empty queue
    // but handle it anyway
    if (_notifyQueue.queue.length > 0) {
      postNotification(_notifyQueue.queue.splice(0, 1)[0]);
      _lastMessageTime = t;
      remaining = _notifyQueue.interval;
    }
  }

  if (byTimer) _timerHandle = null; // the timer that called us is an ex-timer
  if (_notifyQueue.queue.length == 0) {
    // queue's empty, no need for another callback
    if (_timerHandle) Timer.clear(_timerHandle);
  } else if (!_timerHandle) {
    // there's more to come yet no timer in play -> schedule the next callback
    // time remaining should be in the range [0, _notifyQueue.interval]
    var interval = Math.max(0, Math.min(remaining, _notifyQueue.interval));
    //console.log('_notifyWrite', interval, 'qlen=' + _notifyQueue.queue.length);
    _timerHandle = Timer.set(interval * 1000, false, _notifyWrite, true);
  }
}

var _lastMessage;
var _sequenceNumber = 0;
function _notify() {
  if (!CONFIG.httpNtfyURL) return;
  // suppress duplicates; can't just peek at the queue as it may have been
  // serviced already
  var message = arguments.join(' ');
  if (message === _lastMessage) return;
  _lastMessage = message;

  // discard oldest messages to make room for new ones
  if (_notifyQueue.queue.length >= _notifyQueue.maxSize) {
    // delete the 0'th message, (attempt to) report it
    console.log('_notify overflow:', JSON.stringify(_notifyQueue.queue.splice(0, 1)[0]));
  }
  _notifyQueue.queue.push(message + '\n' + _sequenceNumber++);
  _notifyWrite(); // service the queue if possible (attempt a write 'asap')
}

/*** end queue ***/


function _callbackLogError(result, errorCode, errorMessage) {
  if (errorCode != 0) {
    console.log('call failed: ', errorCode, errorMessage);
  }
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
  console.log('postNotification [' + JSON.stringify(message) + ']');
  //Shelly.call("HTTP.Request", params, _callbackLogError);
}

function updateStatus(notifyStatus) {
  // a 'script started' status update will be delivered immediately and then
  // heartbeat and other ad-hoc updates from then on
  // - these will all be discarded until the notification queue catches up

  // heartbeats are every 60s with a separate notification for every switch
  // (i.e. four in rapid succession for a Pro4PM); this will trip up
  // console.log() rate limiting (in conjunction with the other log calls), so
  // skip them totally
  var delta = notifyStatus.delta;
  if (delta && delta.aenergy) return;
  console.log('update from', notifyStatus.name + ':' + notifyStatus.id);

  // include (switch) output state if present
  _notify('update from', notifyStatus.name + ':' + notifyStatus.id +
    (delta && delta.output !== undefined ? ' (' + (delta.output ? 'on' : 'off') + ')' : ''));
}

function init() {
  if (CONFIG.httpNtfyURL) {
    CONFIG.httpNtfyURL += Shelly.getDeviceInfo().id || 'shelly';
    console.log('httpNtfyURL ', CONFIG.httpNtfyURL);
  }
  _notify('script start');
  _notify('script start');  // duplicate; will be ignored

  // pile on a bunch of notifications - should hit queue overflow from
  // maxSize+1 on; i.e. the first one above will have been sent immediately
  // as the queue was empty and rate limit not hit; the next maxSize will be
  // queued up
  for (var i = 1; i < _notifyQueue.maxSize+2; i++) {
    _notify('start', i);
  }

  Shelly.addStatusHandler(updateStatus);
}

init();