#!/usr/bin/env python3
# Backing up is hard to do.
# This script can:
# - capture a Shelly Gen2 device configuration (producing a JSON representation)
# - restore a device configuration
# - calculate a diff between a given configuration and the live device
#
# Approach
# Shelly's API is separated into Components and Services




import requests
import requests.auth
import json
import os
import sys
import argparse
import logging
import http.client
import base64
import difflib
import itertools

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s: %(message)s',
    stream=sys.stderr 
)
logger = logging.getLogger(__name__)

# --- Global State and Constants ---
# (Constants and global state definitions remain unchanged)
auth_handler = None
USERNAME = None
PASSWORD = None

COMPONENT_MAP = {
    'core': 'core_features',       
    'webhook': 'webhook_list',     
    'schedule': 'schedule_list',   
    'script': 'script_configs',    
}

SCRIPT_MODE_OPTIONS = ['none', 'inline', 'base64']
MODE_OPTIONS = ['backup', 'restore', 'diff']

SENSITIVE_FIELDS = [
    "Sys.device.mac",
    "Sys.location.lat",
    "Sys.location.lon",
    "Wifi.ap.ssid",
    "Wifi.ap.pass",
    "Wifi.sta.ssid",
    "Wifi.sta.pass",
    "Mqtt.server",
    "Mqtt.user",
    "Cloud.user",
    "Cloud.pass",
    "Action.urls",  
    "Webhook.list.webhook.url", 
    "Schedule.list.calls.url", 
    "Script.config.name"
]

REDACTION_PLACEHOLDER = "[REDACTED]"


# --- Core Helper Functions ---

def safe_unescape_json_string(s):
    """Safely interprets JSON escape sequences within a string (e.g., '\\n' to '\n')."""
    if not isinstance(s, str) or not s:
        return s
    
    try:
        quoted_text = f'"{s.replace("\"", "\\\"")}"'
        return json.loads(quoted_text)
    except (json.JSONDecodeError, TypeError):
        return s 

def _diff_format_line(line_num, left, sep, right, width, sep_width=3):
    """Formats a single line using a DRY template."""
    # bring on python 3.14's template strings
    # pad left and right, for consistency between the two
    return "{line_num:>3} | {left:<{width}}{sep:^{sep_width}}{right:<{width}}".format(
        line_num=line_num,
        left=left,
        right=right,
        width=width, 
        sep=sep,
        sep_width=sep_width
    )

def get_side_by_side_diff(text_left, text_right, width=50, suppress_equal=True):
    """Generates a text-based side-by-side diff; oblivious to trailing whitespace."""
    # Ensure inputs are strings
    text_left = text_left if text_left is not None else ""
    text_right = text_right if text_right is not None else ""

    # splitlines removes trailing line breaks; go the whole hog and remove all trailing whitespace
    lines_left = [s.rstrip() for s in text_left.splitlines()]
    lines_right = [s.rstrip() for s in text_right.splitlines()]
    
    # SequenceMatcher compares pairs of sequences, get_opcodes() describes how to turn left into
    # right though we're only interested in the crude tags
    diff = difflib.SequenceMatcher(None, lines_left, lines_right)
    output = []
    linenum = 0

    sep = "|"
    output.append(_diff_format_line('#', 'INPUT (File)', sep, 'DEVICE (Live)', width))
    output.append(_diff_format_line('', '-'*width, sep, '-'*width, width))

    for tag, a0, a1, b0, b1 in diff.get_opcodes():
        for l, r in itertools.zip_longest(lines_left[a0:a1], lines_right[b0:b1]):
            l = l or ""
            r = r or ""
            
            # Truncate lines to fit width
            l_fmt = (l[:width-3] + '...') if len(l) > width else l
            r_fmt = (r[:width-3] + '...') if len(r) > width else r
            
            linenum += 1

            if tag == 'equal':
                if suppress_equal: continue
                tag = " "
            elif tag == 'replace': tag = "|"
            elif tag == 'delete': tag = "<"
            elif tag == 'insert': tag = ">"

            output.append(_diff_format_line(linenum, l_fmt, tag, r_fmt, width))
                
    return "\n".join(output)

def redact_sensitive_fields(data: dict, sensitive_keys: list):
# ... (function body unchanged)
    def _traverse_and_redact(data_block, path_parts):
        if not path_parts:
            return data_block
        
        key_to_redact = path_parts[0]
        
        if len(path_parts) == 1:
            if isinstance(data_block, dict) and key_to_redact in data_block:
                val = data_block[key_to_redact]
                if val is not None and val != "":
                    data_block[key_to_redact] = REDACTION_PLACEHOLDER
            elif isinstance(data_block, list):
                for item in data_block:
                    if isinstance(item, dict) and key_to_redact in item:
                        val = item[key_to_redact]
                        if val is not None and val != "":
                            item[key_to_redact] = REDACTION_PLACEHOLDER
            return data_block
        
        if isinstance(data_block, dict) and key_to_redact in data_block:
            _traverse_and_redact(data_block[key_to_redact], path_parts[1:])
        elif isinstance(data_block, list):
            for item in data_block:
                _traverse_and_redact(item, path_parts)

    for full_key in sensitive_keys:
        path = full_key.split('.')
        if path[0].lower() == 'list' and len(path) > 1:
            if isinstance(data, dict) and 'list' in data:
                _traverse_and_redact(data['list'], path[1:])
            elif isinstance(data, list):
                 _traverse_and_redact(data, path[1:])
        else:
             _traverse_and_redact(data, path)
    return data

def strip_sensitive_fields(data: dict, sensitive_keys: list):
# ... (function body unchanged)
    def _traverse_and_strip(data_block, path_parts):
        if not path_parts:
            return
        
        key_to_strip = path_parts[0]
        
        if len(path_parts) == 1:
            if isinstance(data_block, dict) and key_to_strip in data_block:
                del data_block[key_to_strip]
            elif isinstance(data_block, list):
                for item in data_block:
                    if isinstance(item, dict) and key_to_strip in item:
                        del item[key_to_strip]
            return
        
        if isinstance(data_block, dict) and key_to_strip in data_block:
            _traverse_and_strip(data_block[key_to_strip], path_parts[1:])
        elif isinstance(data_block, list):
            for item in data_block:
                _traverse_and_strip(item, path_parts)

    for full_key in sensitive_keys:
        path = full_key.split('.')
        if path[0].lower() == 'list' and len(path) > 1:
            if isinstance(data, dict) and 'list' in data:
                _traverse_and_strip(data['list'], path[1:])
            elif isinstance(data, list):
                 _traverse_and_strip(data, path[1:])
        else:
             _traverse_and_strip(data, path)
    return data

def get_credentials():
# ... (function body unchanged)
    global USERNAME, PASSWORD
    auth_string = os.getenv("SHELLYAUTH")
    if auth_string:
        try:
            USERNAME, PASSWORD = auth_string.split(":", 1)
            logger.info("Authentication credentials loaded from SHELLYAUTH.")
        except ValueError:
            logger.error("SHELLYAUTH is not in 'username:password' format.")
            sys.exit(1)

def get_auth_handler(url: str):
# ... (function body unchanged)
    global auth_handler, USERNAME, PASSWORD
    if auth_handler is not None:
        return auth_handler
    if USERNAME is None or PASSWORD is None:
        return None

    logger.debug(f"Attempting request to {url} to detect auth.")
    try:
        response = requests.get(url, timeout=10)
    except requests.exceptions.RequestException as e:
        raise e

    if response.status_code == 401:
        www_authenticate = response.headers.get('WWW-Authenticate', '')
        if 'Digest' in www_authenticate:
            logger.debug("Digest challenge detected.")
            auth_handler = requests.auth.HTTPDigestAuth(USERNAME, PASSWORD)
        elif 'Basic' in www_authenticate:
            logger.debug("Basic challenge detected.")
            auth_handler = (USERNAME, PASSWORD) 
        else:
            logger.warning(f"Unknown auth scheme: {www_authenticate[:30]}...")
            return None
    return auth_handler

def send_authenticated_request(method: str, url: str, params: dict = None, data: dict = None, auth_handler_obj = None):
# ... (function body unchanged)
    auth_kwarg = {'auth': auth_handler_obj} if auth_handler_obj else {}
    request_kwargs = {'url': url, 'timeout': 10, **auth_kwarg}
    
    if method.upper() == 'GET':
        request_kwargs['params'] = params
        request_func = requests.get
    elif method.upper() == 'POST':
        request_kwargs['json'] = data
        request_func = requests.post
    else:
        raise ValueError(f"Unsupported method: {method}")

    if http.client.HTTPConnection.debuglevel == 2:
        logger.debug(f"--- Raw Request to {url} ({method}) ---")
        if data:
            logger.debug(f"Body: {json.dumps(data)}")
        try:
            response = request_func(**request_kwargs)
            try:
                raw_response_body = response.content.decode(response.encoding or 'utf-8', errors='ignore')
                logger.debug(f"--- Raw Response Body from {url} ---")
                logger.debug(raw_response_body)
            except Exception as e:
                logger.warning(f"Log decode fail: {e}")
        except requests.exceptions.RequestException as e:
            raise e
        return response
    else:
        return request_func(**request_kwargs)

def fetch_and_redact_config(base_url: str, api_method: str, params: dict, final_storage_key: str, auth_handler_obj, redact: bool, full_config_dump: dict):
# ... (function body unchanged)
    request_url = f"{base_url}/{api_method}"
    try:
        logger.info(f"  -> Fetching config for {final_storage_key}...")
        response = send_authenticated_request('GET', request_url, params=params, auth_handler_obj=auth_handler_obj)
        response.raise_for_status()
        config_data = response.json()
        
        if redact:
            prefix = final_storage_key + '.'
            feature_sensitive_keys = [k[len(prefix):] for k in SENSITIVE_FIELDS if k.startswith(prefix)]
            config_data = redact_sensitive_fields(config_data, feature_sensitive_keys)
        
        full_config_dump[final_storage_key] = config_data
        logger.info(f"  Successfully retrieved {final_storage_key}.")
    except requests.exceptions.RequestException as e:
        logger.error(f"  Error fetching {final_storage_key}: {e}")
        full_config_dump[final_storage_key] = {"error": str(e)}

# --- Fetch Implementations ---

def _fetch_core_features(base_url: str, auth_handler_obj, redact: bool, final_config_dump: dict):
# ... (function body unchanged)
    initial_url = f"{base_url}/Shelly.GetConfig"
    logger.info("Fetching core features...")
    try:
        response = send_authenticated_request('GET', initial_url, params={}, auth_handler_obj=auth_handler_obj)
        response.raise_for_status()
        top_level_keys = response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching initial config: {e}")
        return False

    for key, value in top_level_keys.items():
        if ":" in key:
            feature_type, feature_id_str = key.split(":")
            api_method = f"{feature_type.capitalize()}.GetConfig"
            params = {"id": int(feature_id_str)}
            final_storage_key = key
        else:
            api_method = f"{key.capitalize()}.GetConfig"
            params = {}
            final_storage_key = key.capitalize()
            
        fetch_and_redact_config(base_url, api_method, params, final_storage_key, auth_handler_obj, redact, final_config_dump)
    return True

def _fetch_webhook_list(base_url: str, auth_handler_obj, redact: bool, final_config_dump: dict):
# ... (function body unchanged)
    logger.info("Fetching Webhook list...")
    fetch_and_redact_config(base_url, "Webhook.List", {}, "Webhook", auth_handler_obj, redact, final_config_dump)

def _fetch_schedule_list(base_url: str, auth_handler_obj, redact: bool, final_config_dump: dict):
# ... (function body unchanged)
    logger.info("Fetching Schedule list...")
    fetch_and_redact_config(base_url, "Schedule.List", {}, "Schedule", auth_handler_obj, redact, final_config_dump)

def _fetch_script_configs(base_url: str, auth_handler_obj, redact: bool, script_mode: str, final_config_dump: dict):
# ... (function body unchanged)
    logger.info("Fetching script list...")
    try:
        response = send_authenticated_request('GET', f"{base_url}/Script.List", params={}, auth_handler_obj=auth_handler_obj)
        response.raise_for_status()
        scripts = response.json().get('scripts', [])
        
        for script_data in scripts:
            script_id = script_data.get('id')
            if script_id is not None:
                final_storage_key = f"Script:{script_id}"
                params = {"id": script_id}
                try:
                    if script_mode != 'none':
                        api_code = "Script.GetCode"
                        logger.info(f"  -> Fetching code for {final_storage_key}...")
                        code_resp = send_authenticated_request('GET', f"{base_url}/{api_code}", params=params, auth_handler_obj=auth_handler_obj)
                        code_resp.raise_for_status()
                        raw_code = code_resp.text
                        
                        if script_mode == 'base64':
                            script_data['code_base64'] = base64.b64encode(raw_code.encode('utf-8')).decode('utf-8')
                        else:
                            script_data['code_inline'] = raw_code
                    
                    if redact:
                        prefix = final_storage_key + '.'
                        keys = [k[len(prefix):] for k in SENSITIVE_FIELDS if k.startswith(prefix)]
                        script_data = redact_sensitive_fields(script_data, keys)

                    final_config_dump[final_storage_key] = script_data
                    logger.info(f"  Successfully retrieved {final_storage_key}.")
                except Exception as e:
                    logger.error(f"  Error fetching script {script_id}: {e}")
                    final_config_dump[final_storage_key] = {"error": str(e)}
    except Exception as e:
        logger.error(f"Error listing scripts: {e}")

# --- Restore Implementations ---

def _restore_core_feature(base_url, component_key, config_data, auth_handler_obj):
    if ":" in component_key:
        ftype, fid = component_key.split(":")
        api = f"{ftype.capitalize()}.SetConfig"
        payload = {"id": int(fid), "config": config_data}
    else:
        ftype = component_key
        api = f"{ftype.capitalize()}.SetConfig"
        payload = {"config": config_data}

    try:
        logger.info(f"  -> Restoring {component_key} via {api}...")
        resp = send_authenticated_request('POST', f"{base_url}/{api}", data=payload, auth_handler_obj=auth_handler_obj)
        resp.raise_for_status()
        
        data = resp.json()
        # SUCCESS: Shelly returns a 'result' key
        if "result" in data:
            if data["result"].get("restart_required"):
                logger.warning(f"  ⚠️ Restored {component_key} (REBOOT REQUIRED).")
            else:
                logger.info(f"  ✅ Successfully saved {component_key}.")
        else:
            # Handle cases where status is 200 but an error is in the body
            error_msg = data.get("message", "Unknown API error")
            logger.error(f"  ❌ Error restoring {component_key}: {error_msg}")

    except Exception as e:
        logger.error(f"  ❌ Connection error restoring {component_key}: {e}")

def _restore_scripts(base_url: str, key: str, data: dict, auth_handler_obj):
# ... (function body unchanged)
    sid = data.get('id')
    if sid is None: return

    code = data.get('code_inline')
    if not code and 'code_base64' in data:
        try:
            code = base64.b64decode(data['code_base64']).decode('utf-8')
        except:
            pass

    if code and code != REDACTION_PLACEHOLDER:
        try:
            logger.info(f"  -> Uploading code for script {sid}...")
            send_authenticated_request('POST', f"{base_url}/Script.PutCode", params={"id": sid, "code": code}, auth_handler_obj=auth_handler_obj).raise_for_status()
            logger.info(f"  ✅ Code uploaded for {sid}.")
        except Exception as e:
            logger.error(f"  ❌ Error uploading code {sid}: {e}")
    
    payload = {"id": sid, "config": {"name": data.get('name'), "enable": data.get('enable')}}
    if 'config' in data and isinstance(data['config'], dict):
        payload['config'].update(data['config'])
    
    try:
        logger.info(f"  -> Restoring config for script {sid}...")
        send_authenticated_request('POST', f"{base_url}/Script.SetConfig", data=payload, auth_handler_obj=auth_handler_obj).raise_for_status()
        logger.info(f"  ✅ Config restored for {sid}.")
        if data.get('running'):
            send_authenticated_request('POST', f"{base_url}/Script.Start", data={"id": sid}, auth_handler_obj=auth_handler_obj)
            logger.info(f"  ✅ Started script {sid}.")
    except Exception as e:
        logger.error(f"  ❌ Error restoring script {sid}: {e}")

def restore_shelly_config(device_ip: str, config_file_path: str, redact: bool):
# ... (function body unchanged)
    global auth_handler
    base_url = f"http://{device_ip}/rpc"
    get_credentials()
    
    if config_file_path:
        try:
            with open(config_file_path, 'r') as f:
                config_dump = json.load(f)
        except Exception as e:
            logger.error(f"Load error: {e}")
            sys.exit(1)
    else:
        try:
            config_dump = json.load(sys.stdin)
        except Exception as e:
            logger.error(f"Stdin error: {e}")
            sys.exit(1)

    try:
        auth_handler = get_auth_handler(f"{base_url}/Shelly.GetConfig")
    except:
        sys.exit(1)
        
    logger.info(f"**Starting RESTORE to {device_ip}...**")
    for key, data in config_dump.items():
        if redact:
            prefix = key + '.'
            keys = [k[len(prefix):] for k in SENSITIVE_FIELDS if k.startswith(prefix)]
            if keys:
                data = strip_sensitive_fields(data, keys)

        if key.startswith("Script:"):
            _restore_scripts(base_url, key, data, auth_handler)
        elif key in ["Webhook", "Schedule"]:
            _restore_core_feature(base_url, key, data, auth_handler)
        else:
            _restore_core_feature(base_url, key, data, auth_handler)
    logger.info("Restore complete.")

# ----------------------------------------------------------------------
# DIFF IMPLEMENTATION
# ----------------------------------------------------------------------

def compare_json_recursive(path, input_val, live_val, diffs):
# ... (function body unchanged)
    # --- Special handling for Script Code Diff ---
    if path.endswith("code_inline") or path.endswith("code_base64"):
        
        # --- Normalize Input ---
        val_in = input_val
        if path.endswith("code_base64"):
            try:
                val_in = base64.b64decode(input_val).decode('utf-8')
            except:
                pass
        elif isinstance(val_in, str):
            # Apply JSON unescaping for inline code before comparison
            val_in = safe_unescape_json_string(val_in) 
            
        # --- Normalize Live ---
        val_live = live_val
        if path.endswith("code_base64"):
            try:
                val_live = base64.b64decode(live_val).decode('utf-8')
            except:
                pass
        elif isinstance(val_live, str):
            # Apply JSON unescaping for inline code before comparison
            val_live = safe_unescape_json_string(val_live) 
        
        if val_in != val_live:
            diffs.append(f"\n⚠️  Code Difference Detected for {path}:")
            # get_side_by_side_diff now receives the fully unescaped, multiline text
            vis_diff = get_side_by_side_diff(val_in, val_live)
            diffs.append(vis_diff + "\n")
        return
    # ----------------------------------------------

    if type(input_val) != type(live_val):
        if (isinstance(input_val, (int, float)) and isinstance(live_val, (int, float))):
             if float(input_val) != float(live_val):
                 diffs.append(f"{path}: Expected {input_val} (input), Found {live_val} (device)")
             return
        diffs.append(f"{path}: Type mismatch. Input: {type(input_val).__name__}, Device: {type(live_val).__name__}")
        return

    if isinstance(input_val, dict):
        for k, v in input_val.items():
            if k not in live_val:
                diffs.append(f"{path}.{k}: Missing on device")
            else:
                compare_json_recursive(f"{path}.{k}", v, live_val[k], diffs)
    elif isinstance(input_val, list):
        if len(input_val) != len(live_val):
             diffs.append(f"{path}: List length mismatch. Input: {len(input_val)}, Device: {len(live_val)}")
        for i, v in enumerate(input_val):
            if i >= len(live_val):
                diffs.append(f"{path}[{i}]: Missing index on device")
            else:
                compare_json_recursive(f"{path}[{i}]", v, live_val[i], diffs)
    else:
        if input_val != live_val:
            diffs.append(f"{path}: Expected '{input_val}', Found '{live_val}'")

def perform_diff(device_ip: str, config_file_path: str, redact: bool, component_filter: set):
# ... (function body unchanged)
    if config_file_path:
        try:
            with open(config_file_path, 'r') as f:
                input_config = json.load(f)
        except Exception as e:
            logger.error(f"Load error: {e}")
            sys.exit(1)
    else:
        try:
            input_config = json.load(sys.stdin)
        except Exception as e:
            logger.error(f"Stdin error: {e}")
            sys.exit(1)

    if redact:
        logger.info("Redaction enabled: Sensitive fields will be omitted from comparison.")
        for key, data in input_config.items():
            prefix = key + '.'
            keys = [k[len(prefix):] for k in SENSITIVE_FIELDS if k.startswith(prefix)]
            if keys:
                strip_sensitive_fields(data, keys)

    script_mode = 'none'
    has_scripts = any(k.startswith("Script:") for k in input_config.keys())
    if has_scripts:
        for k, v in input_config.items():
            if k.startswith("Script:"):
                if 'code_base64' in v:
                    script_mode = 'base64'
                    break
                elif 'code_inline' in v:
                    script_mode = 'inline'
                    break
    
    logger.info(f"Fetching live configuration from {device_ip} for comparison...")
    live_config = backup_shelly_config(device_ip, redact=False, component_filter=component_filter, script_mode=script_mode)
    
    if live_config is None:
        logger.error("Failed to fetch live configuration.")
        sys.exit(1)

    logger.info("** Starting Comparison (Input vs Device) **")
    all_diffs = []
    
    for key, input_data in input_config.items():
        if key not in live_config:
            all_diffs.append(f"Feature '{key}': Present in input, MISSING on device.")
            continue
        live_data = live_config[key]
        if "error" in live_data:
            all_diffs.append(f"Feature '{key}': Error in live data - {live_data['error']}")
            continue
        compare_json_recursive(key, input_data, live_data, all_diffs)

    if not all_diffs:
        print("✅ No differences found. Device matches input configuration.")
    else:
        print(f"⚠️  Found {len(all_diffs)} difference(s):")
        for diff in all_diffs:
            print(f" - {diff}")
    if all_diffs:
        sys.exit(1)


# --- Backup Dispatcher ---
def backup_shelly_config(device_ip: str, redact: bool, component_filter: set, script_mode: str):
# ... (function body unchanged)
    global auth_handler
    base_url = f"http://{device_ip}/rpc"
    final_config_dump = {}
    get_credentials()
    
    try:
        if auth_handler is None:
            auth_handler = get_auth_handler(f"{base_url}/Shelly.GetConfig")
    except:
        return None
        
    logger.info(f"Connecting to {device_ip}...")
    
    if COMPONENT_MAP['core'] in component_filter:
        if not _fetch_core_features(base_url, auth_handler, redact, final_config_dump):
            return None
    if COMPONENT_MAP['webhook'] in component_filter:
        _fetch_webhook_list(base_url, auth_handler, redact, final_config_dump)
    if COMPONENT_MAP['schedule'] in component_filter:
        _fetch_schedule_list(base_url, auth_handler, redact, final_config_dump)
    if COMPONENT_MAP['script'] in component_filter:
        _fetch_script_configs(base_url, auth_handler, redact, script_mode, final_config_dump)

    return final_config_dump


def main():
# ... (function body unchanged)
    parser = argparse.ArgumentParser(description="Shelly Backup, Restore & Diff Tool")
    parser.add_argument("device_ip", help="IP of the Shelly device")
    parser.add_argument("output_file", nargs="?", default=None, help="Config file path")
    parser.add_argument("-m", "--mode", choices=MODE_OPTIONS, default="backup", help="Mode: backup, restore, diff")
    parser.add_argument("-v", "--verbose", type=int, nargs='?', const=1, choices=[0, 1, 2], default=0, help="Verbosity 0-2")
    parser.add_argument("-r", "--redact", action="store_true", help="Redact/Strip sensitive fields")
    parser.add_argument("-c", "--components", type=str, default="core,webhook,schedule,script", help="Component filter")
    parser.add_argument("--scripts", choices=SCRIPT_MODE_OPTIONS, default="inline", help="Script fetch mode")
    
    args = parser.parse_args()

    if args.verbose >= 1:
        logger.setLevel(logging.DEBUG)
        if args.verbose == 1:
            http.client.HTTPConnection.debuglevel = 1
        elif args.verbose == 2:
            http.client.HTTPConnection.debuglevel = 2
        
    comp_names = [n.strip().lower() for n in args.components.split(',')]
    comp_filter = set()
    for n in comp_names:
        if n in COMPONENT_MAP:
            comp_filter.add(COMPONENT_MAP[n])
        else:
            logger.warning(f"Unknown component '{n}'")
    if not comp_filter:
        logger.error("No valid components.")
        sys.exit(1)

    if args.mode == 'backup':
        if not args.output_file:
            logger.info("*** Mode: BACKUP (stdout) ***")
        else:
            logger.info("*** Mode: BACKUP (file) ***")
        
        data = backup_shelly_config(args.device_ip, args.redact, comp_filter, args.scripts)
        if data is None:
            sys.exit(1)
        
        if args.output_file:
            try:
                with open(args.output_file, 'w') as f:
                    json.dump(data, f, indent=4)
                logger.info("Saved.")
            except Exception as e:
                logger.error(e)
                sys.exit(1)
        else:
            print(json.dumps(data, indent=4))
            
    elif args.mode == 'restore':
        logger.info("*** Mode: RESTORE ***")
        restore_shelly_config(args.device_ip, args.output_file, args.redact)
        
    elif args.mode == 'diff':
        logger.info("*** Mode: DIFF ***")
        perform_diff(args.device_ip, args.output_file, args.redact, comp_filter)

if __name__ == "__main__":
    main()