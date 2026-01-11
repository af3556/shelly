#!/usr/bin/env bash
# check a shelly's operational state; track uptime and temperature
# will detect
# - offline state (i.e. failed RPC)
# - reboots (uptime decrease)
# - over-temperature
# and send a notification via ntfy.sh

curl_opts() {
  # --silent+show-error: be quiet except when things go wrong
  # --fail = exit status (22) on any HTTP status >=400
  # (writing out the non-JSON error body is pointless as that's piped to jq)
  curl --silent --show-error --fail "$@"
}

if (( $# < 2 )); then
  echo "usage: $0 shellyhost statefile [logfile (default: stdout)]" >&2
  exit 1
fi

SHELLY="$1"
STATE_FILE="$2"
LOG_FILE="$3"

if (( $# < 3 )); then
  exec {LOG_FD}>&1
else
  if ! exec {LOG_FD}>>"$LOG_FILE"; then  # append
    echo "can't write to log file [$LOG_FILE], using stdout" >&2
  fi
fi

log() {
  local IFS=$'\t'
  # write timestamp, fallback to stdout
  printf "%(%F %R)T\t%s\t%s\n" -1 "$*" >&${LOG_FD:-1}
}

# HOSTNAME is set by bash so will be present even under cron
topic="${HOSTNAME}-${SHELLY}"
# ntfy topics only allow [\w_-]+, replace anything else with _
NTFY="https://ntfy.sh/${topic//[^[:alnum:]_-]/_}"

# the P4o4PM max ambient is 40C; max. internal temp is unspecified
# observationally internal temps are ~+20 above ambient, and general
# consumer/commercial electronics will start having problems ca. 70C
# bash can't do floating point, so must be integer
MAXTEMP=60

trap 'declare -p uptime errcount > "$STATE_FILE"' EXIT

uptime=0
errcount=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null # SC1090
  source "$STATE_FILE"
else
  echo "$0 no prior state"
fi

# the subshell will exit with various status codes:
# 0 on a-ok; 1 on read error; 10-99 on low-priority error (connect failure or
# reboot) and 100+ on high-priority error (overtemp)
#
# aside: MAXTEMP is available in the subshell, as the latter is a forked copy
# of the parent (if there were an exec involved, export would be required)

get_shelly_status() {
  curl_opts ${SHELLYAUTH+--anyauth --user "${SHELLYAUTH}"} "http://${SHELLY}/rpc/Shelly.GetStatus" |
    jq --raw-output '[.sys.uptime, ."switch:0".temperature.tC] | @tsv' |
    {
      IFS=$'\t' read -r newuptime temperature remainder

      if [[ -z $newuptime || -z $temperature ]]; then
        echo "failed to read JSON data: [$newuptime, $temperature, $remainder]" >&2
        exit 1
      fi

      echo "$newuptime"
      echo "$temperature"

      if (( newuptime < uptime )); then
        echo "restarted? Uptime decreased: expected > $uptime, got $newuptime" >&2
        exit 10
      fi

      printf -v t "%.0f" "$temperature" # zero decimal places (i.e. int())
      if (( t > MAXTEMP )); then
        echo "high temperature ($t>$MAXTEMP)" >&2
        exit 100
      fi

      exit 0
  }
  RC=( "${PIPESTATUS[@]}" )
  # this function is intended to be called via process substitution <()
  # so an exit instead of return would work "just as well", but would be subtly
  # wrong ;-)
  return "${RC[-1]}"
}

# capture errors (stderr) too; will be a mix of curl/jq etc
# aside: attempting to read stdout and err independently (e.g. via fifos) is
# fraught with hazards (e.g. blocking); KISS
readarray -t shelly_status < <(get_shelly_status 2>&1)
wait "$!" # populate $? from <() https://mywiki.wooledge.org/ProcessSubstitution
rc=$?

log "$rc" "${shelly_status[*]}"

if (( rc == 0 )); then
  # update state
  errcount=0
  uptime="${shelly_status[0]}"
else
  errcount=$((errcount+1))
  # ntfy only on a diminishing sequence of errors (errcount == 2^n-1)
  # - the bitwise AND will be 0/false only when errcount is about to step up to the next bit boundary, e.g. 1, 3, 7, 15, ...
  if ! (( (errcount + 1) & errcount )); then
    t="$SHELLY [$HOSTNAME]"
    # report shelly_status error message(s)
    m="${shelly_status[*]} errcount=$errcount"
    headers=(-H "X-Title: ${t}")
    if (( rc >= 100 )); then
        headers+=(-H "Priority: high" -H "Tags: warning")
    fi
    curl_output=$(curl_opts "${headers[@]}" -d "$m" "$NTFY" 2>&1)
    curl_rc=$?
    if (( curl_rc != 0 )); then
      log "ntfy failed: $curl_rc" "$curl_output"
    fi
  fi
fi

exit $rc
