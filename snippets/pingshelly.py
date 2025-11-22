#!/usr/bin/env python3
# an incomplete experiment to compare python and bash implementations; imnsho bash wins by a
# comfortable margin as it's much shorter and simpler to see what's going on, however that latter
# statement is only true if you're familiar with the tools that the shell script employs to do most
# of the actual work (curl, jq)

import requests
import json
import os
import sys
import datetime
import socket

# the P4o4PM max ambient is 40C; max. internal temp is unspecified
# observationally internal temps are ~+20 above ambient, and general
# consumer/commercial electronics will start having problems ca. 70C
MAXTEMP = 60
NTFY_URL = "https://ntfy.sh/shelly" # replace this with your topic path

_current_uptime = 0
_error_count = 0

_log_fd = sys.stdout

def _get_filename(shelly_host, env_name, extension):
    script_name = os.path.basename(sys.argv[0])
    # basename the target host to prevent typos from splatting files in odd
    # places (e.g. an IP address of 10.1.2/3)
    shelly_base_name = os.path.basename(shelly_host)
    default_filename = f"{script_name}.{shelly_base_name}.{extension}"
    return os.environ.get(env_name, os.path.join('/var/local', default_filename))

def setup_logging(shelly_host):
    """
    Sets up logging to stdout if connected to a TTY, otherwise to a log file.
    """
    global _log_fd

    if sys.stdout.isatty():
      return

    _log_file_path = _get_filename(shelly_host, 'SHELLY_LOG_FILE', 'log')

    try:
        _log_fd = open(_log_file_path, 'a') # append
    except IOError as e:
      # stdout might not be a tty, but maybe stderr is?
        print(f"Error opening log file {_log_file_path}: {e}", file=sys.stderr)
        _log_fd = sys.stderr

def log_data(message, *args, **kwargs):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    full_message = f"{timestamp}\t{message.format(*args, **kwargs)}\n"
    if _log_fd:
        _log_fd.write(full_message)
        # not necessary: _log_fd.flush()

def get_state_filepath(shelly_host):
    return _get_filename(shelly_host, 'SHELLY_STATE_FILE', 'state')

def load_state(filepath):
    """
    Reads uptime and error count from the state file, if present
    """
    global _current_uptime, _error_count
    _current_uptime = 0
    _error_count = 0
    try:
        with open(filepath, 'r') as f:
            for line in f:
                if line.startswith("uptime="):
                    _current_uptime = int(line.split('=')[1].strip())
                elif line.startswith("errcount="):
                    _error_count = int(line.split('=')[1].strip())
        print(f"Loaded: uptime={_current_uptime}, errcount={_error_count}", file=sys.stderr)
    except (IOError, ValueError) as e:
        print(f"Warning: Could not read state file {filepath}: {e}. Starting with fresh state.", file=sys.stderr)

def save_state(filepath):
    """
    Saves the current uptime and error count to the state file.
    This function is registered to run on script exit.
    """
    try:
        with open(filepath, 'w') as f:
            f.write(f"uptime={_current_uptime}\n")
            f.write(f"errcount={_error_count}\n")
        print(f"State saved: uptime={_current_uptime}, errcount={_error_count}", file=sys.stderr)
    except IOError as e:
        print(f"Error saving state to {filepath}: {e}", file=sys.stderr)

# --- Shelly Status Check ---

def get_shelly_status(shelly_host):
    """
    Fetches status from Shelly device, checks uptime and temperature.
    Returns a tuple: (status_code, uptime, temperature, message)
    status_code: 0=OK, 1=Read/Network Error, 10=Reboot, 100=Over-temperature
    """
    global _current_uptime

    url = f"http://{shelly_host}/rpc/Shelly.GetStatus"
    new_uptime = None
    temperature = None
    message = ""
    status_code = 0

    try:
        response = requests.get(url, timeout=10) # 10 second timeout
        response.raise_for_status() # Raise an HTTPError for bad responses (4xx or 5xx)
        data = response.json()

        # Extract uptime and temperature
        new_uptime = data.get('sys', {}).get('uptime')
        # Shelly Plus devices use "switch:0".temperature.tC for internal temperature
        # Shelly Gen 1 devices might use "tmp".tC or similar.
        # This script assumes Shelly Plus format.
        temperature_data = data.get('switch:0', {}).get('temperature')
        if temperature_data:
            temperature = temperature_data.get('tC')

        if new_uptime is None or temperature is None:
            message = f"Failed to read JSON data: uptime={new_uptime}, temperature={temperature}"
            status_code = 1
        else:
            # Check for uptime decrease (reboot)
            if new_uptime < _current_uptime:
                message = f"Restarted? Uptime decreased: expected > {_current_uptime}, got {new_uptime}"
                status_code = 10

            # Check for high temperature
            # Convert temperature to integer for comparison as in bash script
            temp_int = int(temperature)
            if temp_int > MAXTEMP:
                if status_code == 0: # Only set if no other higher priority issue
                    message = f"High temperature: {temperature}°C (max {MAXTEMP}°C)"
                    status_code = 100
                else: # Append temperature warning if another issue already detected
                    message += f"; High temperature: {temperature}°C (max {MAXTEMP}°C)"

    except requests.exceptions.Timeout:
        message = f"Connection to {shelly_host} timed out."
        status_code = 1
    except requests.exceptions.ConnectionError:
        message = f"Could not connect to {shelly_host}."
        status_code = 1
    except requests.exceptions.HTTPError as e:
        message = f"HTTP error from {shelly_host}: {e.response.status_code} {e.response.reason}"
        status_code = 1
    except json.JSONDecodeError:
        message = f"Failed to decode JSON response from {shelly_host}."
        status_code = 1
    except Exception as e:
        message = f"An unexpected error occurred: {e}"
        status_code = 1

    return status_code, new_uptime, temperature, message

# --- Notification ---

def send_notification(message, priority="default", tags=None):
    """
    Sends a notification via ntfy.sh.
    """
    headers = {}
    if priority == "high":
        headers["Priority"] = "high"
    if tags:
        headers["Tags"] = tags

    try:
        response = requests.post(NTFY_URL, data=message.encode('utf-8'), headers=headers)
        response.raise_for_status()
        print(f"Notification sent successfully: '{message[:50]}...'", file=sys.stderr)
    except requests.exceptions.RequestException as e:
        print(f"Failed to send ntfy notification: {e}", file=sys.stderr)

# --- Main Logic ---

def main():
    global _error_count, _current_uptime

    if len(sys.argv) < 2:
        print("Usage: python shelly_monitor.py <shelly_host>", file=sys.stderr)
        sys.exit(1)

    shelly_host = sys.argv[1]

    # Setup logging first
    setup_logging(shelly_host)

    # Determine state file path and load prior state
    state_filepath = get_state_filepath(shelly_host)
    load_state(state_filepath)

    # Register save_state to run on script exit
    import atexit
    atexit.register(save_state, state_filepath)

    # Get Shelly status
    status_code, new_uptime, temperature, message = get_shelly_status(shelly_host)

    if status_code == 0:
        _error_count = 0
        _current_uptime = new_uptime
        print(f"{status_code}\t{_current_uptime}\t{temperature}", file=sys.stderr)
    else:
        _error_count += 1
        # ntfy only on the first of a sequence of errors
        if _error_count == 1:
            hostname = socket.gethostname()
            notification_message = f"{shelly_host} {message} [{hostname}]"
            if status_code >= 100:
                send_notification(notification_message, priority="high", tags="warning")
            else:
                send_notification(notification_message)
        print(f"{status_code}\t{new_uptime}\t{temperature}\t{message}", file=sys.stderr)

    sys.exit(status_code)

if __name__ == "__main__":
    main()
    # Close the log file descriptor if it's not stdout
    if _log_fd and _log_fd != sys.stdout and _log_fd != sys.stderr:
        _log_fd.close()
