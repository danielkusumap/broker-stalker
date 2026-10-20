FROM nginx:1.27-alpine

# htpasswd untuk basic auth
RUN apk add --no-cache apache2-utils

COPY default.conf /etc/nginx/conf.d/default.conf
# Script di /docker-entrypoint.d dijalankan otomatis sebelum nginx start.
COPY 40-basic-auth.sh /docker-entrypoint.d/40-basic-auth.sh
RUN chmod +x /docker-entrypoint.d/40-basic-auth.sh

EXPOSE 80
