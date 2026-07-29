#!/bin/sh
set -eu

opa check --strict /policies
exec opa "$@"
