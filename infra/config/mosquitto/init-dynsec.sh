#!/bin/sh
# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
set -eu

DYNSEC_FILE="/mosquitto/data/dynamic-security.json"
ADMIN_USER="${MQTT_ADMIN_USER:?Set MQTT_ADMIN_USER}"
ADMIN_PASS="${MQTT_ADMIN_PASSWORD:?Set MQTT_ADMIN_PASSWORD}"
BRIDGE_USER="${MQTT_BRIDGE_USER:-nodered_bridge}"
BRIDGE_PASS="${MQTT_BRIDGE_PASSWORD:-}"

mkdir -p /mosquitto/data /mosquitto/log

if [ ! -f "$DYNSEC_FILE" ]; then
  MOSQ_PID=""
  cleanup_failed_init() {
    if [ -n "$MOSQ_PID" ]; then
      kill -TERM "$MOSQ_PID" 2>/dev/null || true
      wait "$MOSQ_PID" 2>/dev/null || true
    fi
    rm -f "$DYNSEC_FILE"
  }
  trap cleanup_failed_init EXIT

  mosquitto_ctrl dynsec init "$DYNSEC_FILE" "$ADMIN_USER" "$ADMIN_PASS"
  chown 1883:1883 "$DYNSEC_FILE" 2>/dev/null || true
  chmod 600 "$DYNSEC_FILE"

  if [ -n "$BRIDGE_PASS" ]; then
    /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
    MOSQ_PID=$!
    i=0
    while [ "$i" -lt 40 ]; do
      if nc -z 127.0.0.1 1883 2>/dev/null; then
        break
      fi
      i=$((i + 1))
      sleep 0.25
    done

    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec setDefaultACLAccess publishClientSend deny
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec setDefaultACLAccess publishClientReceive deny
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec setDefaultACLAccess subscribe deny
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec setDefaultACLAccess unsubscribe allow

    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec createRole nodered-bridge
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec addRoleACL nodered-bridge subscribePattern "latticedx/#" allow
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec addRoleACL nodered-bridge publishClientReceive "latticedx/#" allow
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec addRoleACL nodered-bridge publishClientSend "latticedx/+/+/command" allow
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec addRoleACL nodered-bridge unsubscribePattern "latticedx/#" allow
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec createClient "$BRIDGE_USER" -p "$BRIDGE_PASS"
    mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PASS" dynsec addClientRole "$BRIDGE_USER" nodered-bridge

    kill -TERM "$MOSQ_PID" 2>/dev/null || true
    wait "$MOSQ_PID" 2>/dev/null || true
    MOSQ_PID=""
    chown 1883:1883 "$DYNSEC_FILE" 2>/dev/null || true
  fi

  trap - EXIT
fi

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
