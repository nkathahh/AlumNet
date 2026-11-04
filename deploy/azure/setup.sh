#!/usr/bin/env bash
# Creates AlumNet's two Azure Container Apps: alumnet-ml (the matching
# service, reachable only from inside Azure) and alumnet-api (the server,
# reached through the Cloudflare gateway). Run it once in Azure Cloud Shell
# (Bash), after the Deploy workflow has published the two images.
#
#   1. Upload ca.pem (Aiven's CA certificate) with Cloud Shell's Upload button.
#   2. bash setup.sh
#
# It asks for each setting. Passwords and keys are typed without being shown
# and are stored as Container Apps secrets, never as plain settings.
set -euo pipefail

ask()        { local v; read -r -p "$1: " v; printf -v "$2" '%s' "$v"; }
ask_default(){ local v; read -r -p "$1 [$3]: " v; printf -v "$2" '%s' "${v:-$3}"; }
ask_secret() { local v; read -r -s -p "$1: " v; echo; printf -v "$2" '%s' "$v"; }

echo "AlumNet: Azure Container Apps setup"
echo
ask_default "GitHub username (owner of the images)" OWNER "nkathahh"
ask_default "Resource group name" GROUP "alumnet"
ask_default "Azure region (pick one near your Aiven region)" LOCATION "southafricanorth"
ask_default "Cloudflare Pages address" APP_URL "https://alumnet.pages.dev"
echo
echo "Aiven database"
ask "Host" DB_HOST
ask "Port" DB_PORT
ask_default "User" DB_USER "avnadmin"
ask_secret "Password" DB_PASSWORD
ask_default "Path to ca.pem" CA_PATH "$HOME/ca.pem"
[ -f "$CA_PATH" ] || { echo "Cannot find $CA_PATH. Upload ca.pem first."; exit 1; }
# One line, with \n for line breaks; both services turn them back into new lines
DB_SSL_CA="$(awk '{printf "%s\\n", $0}' "$CA_PATH")"
echo
echo "Secrets (use the same JWT_SECRET and TOTP_ENC_KEY as your laptop, so"
echo "two-factor keeps working for the accounts you copied across)"
ask_secret "JWT_SECRET" JWT_SECRET
ask_secret "TOTP_ENC_KEY (64 hex characters)" TOTP_ENC_KEY
[[ "$TOTP_ENC_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "TOTP_ENC_KEY must be 64 hex characters."; exit 1; }
# New random keys, made here so they are never typed or copied around
ML_API_KEY="$(openssl rand -hex 32)"
GATEWAY_SECRET="$(openssl rand -hex 32)"

echo
echo "Preparing Azure (a few minutes the first time)..."
az extension add --name containerapp --upgrade --only-show-errors -y
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az group create --name "$GROUP" --location "$LOCATION" --output none
az containerapp env create --name alumnet-env --resource-group "$GROUP" --location "$LOCATION" --output none

echo "Creating the matching service (alumnet-ml)..."
az containerapp create --name alumnet-ml --resource-group "$GROUP" --environment alumnet-env \
  --image "ghcr.io/${OWNER}/alumnet-ml:latest" \
  --target-port 7860 --ingress internal \
  --cpu 1.0 --memory 2.0Gi --min-replicas 0 --max-replicas 1 \
  --secrets "db-password=${DB_PASSWORD}" "db-ssl-ca=${DB_SSL_CA}" "ml-api-key=${ML_API_KEY}" \
  --env-vars "DB_HOST=${DB_HOST}" "DB_PORT=${DB_PORT}" "DB_USER=${DB_USER}" "DB_NAME=alumnet" \
    "DB_PASSWORD=secretref:db-password" "DB_SSL_CA=secretref:db-ssl-ca" "ML_API_KEY=secretref:ml-api-key" \
  --output none
ML_HOST="$(az containerapp show --name alumnet-ml --resource-group "$GROUP" --query properties.configuration.ingress.fqdn -o tsv)"

echo "Creating the server (alumnet-api)..."
az containerapp create --name alumnet-api --resource-group "$GROUP" --environment alumnet-env \
  --image "ghcr.io/${OWNER}/alumnet-api:latest" \
  --target-port 7860 --ingress external \
  --cpu 0.5 --memory 1.0Gi --min-replicas 0 --max-replicas 1 \
  --secrets "db-password=${DB_PASSWORD}" "db-ssl-ca=${DB_SSL_CA}" "jwt-secret=${JWT_SECRET}" \
    "totp-enc-key=${TOTP_ENC_KEY}" "ml-api-key=${ML_API_KEY}" "gateway-secret=${GATEWAY_SECRET}" \
  --env-vars "DB_HOST=${DB_HOST}" "DB_PORT=${DB_PORT}" "DB_USER=${DB_USER}" "DB_NAME=alumnet" "DB_SSL=true" \
    "DB_PASSWORD=secretref:db-password" "DB_SSL_CA=secretref:db-ssl-ca" \
    "JWT_SECRET=secretref:jwt-secret" "JWT_EXPIRES_IN=7d" "TOTP_ENC_KEY=secretref:totp-enc-key" \
    "ML_SERVICE_URL=https://${ML_HOST}" "ML_API_KEY=secretref:ml-api-key" \
    "GATEWAY_SECRET=secretref:gateway-secret" "APP_URL=${APP_URL}" "MEDIA_DRIVER=db" \
  --output none
API_HOST="$(az containerapp show --name alumnet-api --resource-group "$GROUP" --query properties.configuration.ingress.fqdn -o tsv)"

cat <<DONE

Done. Put these two values in Cloudflare Pages (Settings > Variables and secrets):

  BACKEND_URL     https://${API_HOST}
  GATEWAY_SECRET  ${GATEWAY_SECRET}     (choose Encrypt)

Keep GATEWAY_SECRET in your private notes, then clear this screen with: clear

Check: https://${API_HOST}/api/config should say "Open AlumNet from its main address."
The first visit can take a minute while the containers start.
DONE
