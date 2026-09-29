#!/bin/sh
# Refresh the bundled IP-to-ASN snapshot (iptoasn.com, public domain). Run before each release.
set -e
cd "$(dirname "$0")/.."
curl -sSL -o data/ip2asn-v4.tsv.gz https://iptoasn.com/data/ip2asn-v4.tsv.gz
echo "snapshot refreshed: $(date -u +%F)" > data/ip2asn-v4.DATE
