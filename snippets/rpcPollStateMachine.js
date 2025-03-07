/*
This is an exercise in wrapping an RPC call in a state-drive poll loop.
It's a pointless exercise for Shelly RPCs, these should be able to be relied
upon to return properly (i.e. call the callback). With that assumption, all the
state stuff can be eliminated.
*/

var _pollTimer;
// interval is set very low here for demonstration purposes; would typically be
// at least 10x larger
var _pollInterval = 1;  // ms
var _pollCounter = 0;
var deviceConfig;

function _callbackGetConfig(result) {
  deviceConfig = result;
  console.log('_callbackGetConfig:', deviceConfig.sys.device.name);
  _pollCounter = -1; // done!
}

function pollGetConfig() {
  var states = {  // Object.freeze would be good, but not available
    INIT: 'INIT',
    REPEAT: 'REPEAT',
    DONE: 'DONE',
    GIVEUP: 'GIVEUP'
  };
  var state = states.REPEAT;
  if (_pollCounter == 0) state = states.INIT;
  if (_pollCounter < 0) state = states.DONE;
  if (_pollCounter > 10) state = states.GIVEUP;
  _pollCounter++;

  console.log('pollGetConfig', state, JSON.stringify(_pollTimer));
  switch (state) {
    case states.INIT:
      Shelly.call("Shelly.GetConfig", null, _callbackGetConfig);
      _pollTimer = Timer.set(_pollInterval, false, pollGetConfig);  // note: non-repeating
      break;
    case states.REPEAT:
      // check back in a bit, with backoff:
      _pollTimer = Timer.set(3 * _pollInterval * _pollCounter, false, pollGetConfig);
      break;
    case states.GIVEUP:
      console.log('pollGetConfig giving up ¯\\_(ツ)_/¯');
      // falling through
    case states.DONE:
      init();
    break;
  }
}

function init() {
  console.log('init',
    deviceConfig === undefined ? 'failed to get deviceConfig' : 
      'got deviceConfig: ' + deviceConfig.sys.device.name);
  // carry on with rest of the code that uses deviceConfig
}

pollGetConfig();  // this will invoke init()
