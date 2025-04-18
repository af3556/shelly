#!/bin/bash
# check a shelly's operational state; track uptime and temperature
# will detect
# - offline state (i.e. failed RPC)
# - reboots (uptime decrease)
# - over-temperature

curl_opts() {
  curl --silent --show-error "$@"
}

# the P4o4PM max ambient is 40C; max. internal temp is unspecified
# observationally internal temps are ~+20 above ambient, and general
# consumer/commercial electronics will start having problems ca. 70C
# bash can't do floating point, so must be integer
MAXTEMP=60
NTFY=https://ntfy.sh/jonsson-pumphouse-loadshed

if (( $# < 1 )); then
  echo "usage: $0 shellyhost" >&2
  exit 1
fi

SHELLY="$1"
STATE_FILE=/var/local/$(basename "$0").$(basename "$SHELLY" .).state
LOG_FILE=${STATE_FILE%.state}.log

# write the uptime and errcount variables to a 'state' file on our way out
trap 'declare -p uptime errcount > "$STATE_FILE"' EXIT

uptime=0
errcount=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null # SC1090
  source "$STATE_FILE"
else
  echo "$0 no prior state"
fi

# pipefail: want curl's exit status; also, the pipe not consuming all of curl's
# output is itself a fault (https://mywiki.wooledge.org/BashPitfalls#pipefail)
# note that pipefail doesn't report the exit status of the _first_ command, it
# reports the rightmost _failed_ command
# i.e. when the read subshell exit's 1, this will propagate up
# if you care about intermediate process exit status, use PIPESTATUS
#
# aside: MAXTEMP is available in the subshell as the latter is a forked copy
# of the parent (if there were an exec involved, export would be required)

set -o pipefail
uptime=$(curl_opts "http://${SHELLY}/rpc/Shelly.GetStatus" |
  jq --raw-output '[.sys.uptime, ."switch:0".temperature.tC] | @tsv' | {
    IFS=$'\t' read -r newuptime temperature remainder

    if [[ -z $newuptime || -z $temperature ]]; then
      echo "$0 failed to read JSON data: [$newuptime, $temperature, $remainder]" >&2
      exit 1  # exit the | {} subshell
    fi

    printf -v t "%.0f" "$temperature"
    if (( t > MAXTEMP )); then
      m="$SHELLY high temperature: $temperature"
      echo "$m" >&2
      m+=" [$HOSTNAME]"
      curl_opts -H "Priority: high" -H "Tags: warning" -d "$m" "$NTFY"
    fi

    if (( newuptime < uptime )); then
      m="$SHELLY restarted? Uptime decreased: expected > $uptime, got $newuptime"
      echo "$m" >&2
      m+=" [$HOSTNAME]"
      curl_opts -d "$m" "$NTFY"
    fi
    # %T: -1 = current time
    printf -v logmsg "%(%F %R)T\t%s\t%s" -1 "$newuptime" "$temperature"
    # echo log to stderr when it's connected to a tty (i.e. not cron)
    if [ -t 2 ]; then
      echo "$logmsg" | tee --append "$LOG_FILE" >&2
    else
      echo "$logmsg" >> "$LOG_FILE"
    fi
    # return new uptime to be written to the state file (we're in a subshell)
    echo "$newuptime"
  })

rc=$?
pipes=( "${PIPESTATUS[@]}" )
if (( rc != 0 )); then
  errcount=$((errcount+1))
  m="$0 failed: ${pipes[*]}"
  echo "$m" >&2
  # ntfy only on the first of a sequence of errors
  if (( errcount == 1 )); then
    m+=" [$HOSTNAME]"
    curl_opts -d "$m" "$NTFY"
  fi
  exit 1
else
  errcount=0
fi
