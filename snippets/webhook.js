/* webhook example (incomplete)
- 1.4.4: "Uncaught ReferenceError: "Webhook" is not defined"

- unclear whether GET or POST
- don't seem to be able to set headers (i.e. request parameters only)
- no facility to examine the result of the call

Aside: https://webhook.site/5f44e1b4-a2ff-40fd-9c0c-4638999c98d3

*/

// ntfy.sh is a neat, simple HTTP-based pub-sub notification service
// Shelly's Webhook doesn't provide a means to set headers; fortunately
// ntfy.sh can use parameters, incl. for auth
// token replacement `${}`: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook#url-token-replacement
var CONFIG = {
  httpNtfyURL: 'https://ntfy.sh/${config.id}?message=Ping+switch=${status["switch:0"].output}',
}

// review the supported events:
// curl "http://${SHELLY}/rpc/Webhook.ListSupported" | jq .
// input.analog_measurement
// input.analog_change
// switch.on
// switch.off

// not on the list: script changes

// conditions: statement that is evaluated as true

// note that some parameters are required, others optional; they're intermixed
console.log(
Webhook.Create(
  'switch.on',  // event
  1,            // component instance to watch, e.g. switch:1
  true,         // enable
  'switch on',  // name/label
  null,         // HTTPS validatoz: use system/built-in CA
  ['https://webhook.site/5f44e1b4-a2ff-40fd-9c0c-4638999c98d3'], //  URLs to call
  null,         // active between
  '',           // condition: must be true for the webhook to be sent
  10            // minimum period (seconds) between invocations; if negative then edge trigger on condition
)
);
