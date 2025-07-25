
#!/bin/bash
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

if (( $#< 1 )); then
  echo "usage: $0 shellyhost" >&2
  exit 1
fi

SHELLY="$1"

# ntfy topics only allow [\w_-]+
topic="${HOSTNAME#*.}-${SHELLY}"
NTFY="https://ntfy.sh/${topic//[^[:alnum:]-]/_}"

# basename the target host to prevent typos from splatting files in odd places
# (e.g. an IP address of 10.1.2/3)
b=$(basename "$0").$(basename "$SHELLY")
SHELLY_STATE_FILE=${SHELLY_STATE_FILE:-/var/local/"$b".state}
SHELLY_LOG_FILE=${SHELLY_LOG_FILE:-/var/local/"$b".log}

# the P4o4PM max ambient is 40C; max. internal temp is unspecified
# observationally internal temps are ~+20 above ambient, and general
# consumer/commercial electronics will start having problems ca. 70C
# bash can't do floating point, so must be integer
MAXTEMP=60

# when connected to a tty send output to stdout; otherwise (e.g. via cron)
# append to the given log file
# test -t n: true if fd n is connected to a tty
# in days of yore you had to pick an fd and hope it wasn't being used
# (or more rigourously search for a free fd); as of 4.1 bash will allocate one
# for you (and store the allocated fd in LOG_FD, here)
if [ -t 1 ]; then
  exec {LOG_FD}>&1
else
  exec {LOG_FD}>>"$SHELLY_LOG_FILE"  # append
fi

trap 'declare -p uptime errcount > "$SHELLY_STATE_FILE"' EXIT

uptime=0
errcount=0
if [[ -f "$SHELLY_STATE_FILE" ]]; then
  # shellcheck source=/dev/null # SC1090
  source "$SHELLY_STATE_FILE"
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
  curl_opts "http://${SHELLY}/rpc/Shelly.GetStatus" |
    jq --raw-output '[.sys.uptime, ."switch:0".temperature.tC] | @tsv' |
    {
      IFS=$'\t' read -r newuptime temperature remainder

      if [[ -z $newuptime || -z $temperature ]]; then
        echo "failed to read JSON data: [$newuptime, $temperature, $remainder]"
        exit 1  # exit the | {} subshell
      fi

      echo "$newuptime"
      echo "$temperature"

      if (( newuptime < uptime )); then
        echo "restarted? Uptime decreased: expected > $uptime, got $newuptime"
        exit 10
      fi

      printf -v t "%.0f" "$temperature"
      if (( t > MAXTEMP )); then
        echo "high temperature: $temperature"
        exit 100
      fi

      exit 0
  }
  RC=( "${PIPESTATUS[@]}" )
  # this function is intended to be called via process substitution <()
  # so an exit instead of return would work "just as well", but would be subtly
  # wrong ;-)
  # interestingly a ML picked this up, but provided the wrong reasoning as to
  # why it was wrong
  return "${RC[-1]}"
}

readarray -t shelly_status < <(get_shelly_status 2>&1)
wait "$!" # populate $? from <() https://mywiki.wooledge.org/ProcessSubstitution
rc=$?

if (( rc == 0 )); then
  errcount=0
  uptime="${shelly_status[0]}"
else
  errcount=$((errcount+1))
  # ntfy only on the first of a sequence of errors
  if (( errcount == 1 )); then
    # report shelly_status error message(s) (slice)
    m="$SHELLY ${shelly_status[*]:2} [$HOSTNAME]"
    if (( rc >= 100 )); then
        curl_opts -H "Priority: high" -H "Tags: warning" -d "$m" "$NTFY"
    else
        curl_opts -d "$m" "$NTFY"
    fi
  fi
fi

IFS=$'\t'
printf "%(%F %R)T\t%s\t%s\n" -1 "$rc" "${shelly_status[*]}" >&${LOG_FD}
unset IFS

exit $rc
