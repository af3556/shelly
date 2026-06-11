# shelly

Some [Shelly](https://www.shelly.com/) scripts and associated resources.

See also [Shelly Scripting](https://af3556.github.io/posts/shelly-scripting-part1/).

## loadshed.js - intelligently shed loads on a multi-channel switch

This is a "prioritised circuit breaker": four loads are connected to each channel of a Pro4PM, this
script will shed loads one at a time to keep the sum of all loads under the configured total.

An example use case: three pumps and another load are connected to each channel of a Pro4PM. The
pump loads are on time schedules in Shelly such that only one is meant to be on at a time and the
other load is usually low. However it's entirely possible for any combination of loads to exceed
the incoming power circuit's rating and trip the upstream breaker. This script manages this
contention, disabling the lower priority loads (the pumps) in order to keep the overall load below
the configurable limit and thus keep the electrons flowing to the high priority output.

## power-underover-off.js - turn off an output when load crosses a given threshold

This is turns a Shelly output into a "one shot": output shuts off once the load crosses a given
threshold. For example, this can be used to prevent a pressure-controlled water pump from cycling:
when the Shelly device turns the pump on (via a timer, or manually, doesn't matter), this script
will wait until the pump stops (via its pressure-controlled switch) and then cuts the Shelly
output off.

It could also serve as a soft circuit breaker, cutting the load when it exceeds a given value.

The script has no external dependencies, it uses Shelly's asynchronous device status change
notifications to keep track of output state and power.
