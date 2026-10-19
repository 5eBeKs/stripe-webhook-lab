#!/bin/sh
# A test CA made for this stand when it is first started, and a certificate for api.stripe.com signed by it,
# for the stand's Stripe. The gateway trusts only this CA. The CA's key is deleted as soon as the certificate
# is made, and `docker compose down -v` removes the rest.
set -e
cd /tls
if [ -s ca.pem ] && [ -s stripe.pem ] && [ -s stripe.key ]; then
  echo "test CA and the api.stripe.com certificate: already made"
  exit 0
fi
rm -f ./*
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=webhook-lab test CA" \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=api.stripe.com" -keyout stripe.key -out stripe.csr 2>/dev/null
printf 'subjectAltName=DNS:api.stripe.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > ext.cnf
openssl x509 -req -in stripe.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 3650 -extfile ext.cnf \
  -out stripe.pem 2>/dev/null
rm -f ca.key ca.srl stripe.csr ext.cnf
chmod 644 ./*
echo "test CA and the api.stripe.com certificate: made"
