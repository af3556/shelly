# shelly

Some [Shelly](https://www.shelly.com/) scripts and associated resources.

See also [Shelly Scripting](https://af3556.github.io/posts/shelly-scripting-part1/).

## loadshed.js - intelligently shed loads on a multi-channel switch

This is a "software circuit breaker": four loads are connected to each channel of a Pro4PM, this
script will shed loads one at a time to keep the sum of all loads under the configured total.

An example use case: three pumps and another load are connected to each channel of a Pro4PM. The
pump loads are on time schedules in Shelly such that only one is on at a time, and the other load
is usually low. However it's entirely possible for any combination of loads to exceed the incoming
power circuit's rating and trip the upstream breaker. This script manages this contention,
disabling the lower priority loads (the pumps) in order to keep the overall load below the
configurable limit and thus keep the electrons flowing to the high priority output.

## underpower-off.js - turn off an output when load drops below a given threshold

This is turns a Shelly output into a "one shot": output shuts off once the load ceases. For example,
this can be used to prevent a pressure-controlled water pump from cycling: when the Shelly device
turns the pump on (via a timer, or manually, doesn't matter), this script will wait until the pump
stops (via its pressure-controlled switch) and then cuts the Shelly output off.
