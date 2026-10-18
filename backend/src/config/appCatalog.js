// What KubeEZ knows about common apps — used to turn "redis with a 1Gi volume"
// into YAML that is right the first time: a pinned image, the port, a health
// check that works for that app, sensible resources, where its data lives,
// and the settings it needs (passwords are generated, never "CHANGE_ME").
//
//   image      pinned tag (official images on Docker Hub)
//   port       the port it serves; probe: http (path) | tcp | exec (command)
//   data       where it keeps data (a volume is mounted there when asked, or by default for databases)
//   env        settings it needs: { NAME: value | { secret: true } } — secrets get a random value
//   kind       the usual way to run it (StatefulSet for databases)
//   base       a language image without an app — it is kept running; put your own app image there
//   aliases    words people use for it
export const APPS = {
    nginx: { image: 'nginx:1.27-alpine', port: 80, probe: { http: '/' }, cpu: '50m', memory: '64Mi', limit: '128Mi', aliases: ['nginx'] },
    httpd: { image: 'httpd:2.4-alpine', port: 80, probe: { http: '/' }, cpu: '50m', memory: '64Mi', limit: '128Mi', aliases: ['httpd', 'apache', 'apache2', 'apache httpd'] },
    caddy: { image: 'caddy:2.8-alpine', port: 80, probe: { http: '/' }, cpu: '50m', memory: '64Mi', limit: '128Mi', aliases: ['caddy'] },
    redis: { image: 'redis:7.4-alpine', port: 6379, probe: { exec: ['redis-cli', 'ping'] }, cpu: '50m', memory: '64Mi', limit: '256Mi', data: '/data', aliases: ['redis'] },
    memcached: { image: 'memcached:1.6-alpine', port: 11211, probe: { tcp: true }, cpu: '50m', memory: '64Mi', limit: '256Mi', aliases: ['memcached', 'memcache'] },
    postgres: { image: 'postgres:16-alpine', port: 5432, probe: { exec: ['pg_isready', '-U', 'postgres'] }, cpu: '100m', memory: '256Mi', limit: '1Gi', data: '/var/lib/postgresql/data', dataSubPath: 'pgdata', kind: 'StatefulSet', database: true,
        env: { POSTGRES_PASSWORD: { secret: true }, PGDATA: '/var/lib/postgresql/data/pgdata' }, aliases: ['postgres', 'postgresql', 'pg', 'psql'] },
    mysql: { image: 'mysql:8.4', port: 3306, probe: { exec: ['sh', '-c', 'mysqladmin ping -h 127.0.0.1 -p"$MYSQL_ROOT_PASSWORD"'] }, cpu: '200m', memory: '512Mi', limit: '1Gi', data: '/var/lib/mysql', kind: 'StatefulSet', database: true,
        env: { MYSQL_ROOT_PASSWORD: { secret: true } }, initialDelay: 30, aliases: ['mysql'] },
    mariadb: { image: 'mariadb:11.4', port: 3306, probe: { exec: ['healthcheck.sh', '--connect', '--innodb_initialized'] }, cpu: '200m', memory: '256Mi', limit: '1Gi', data: '/var/lib/mysql', kind: 'StatefulSet', database: true,
        env: { MARIADB_ROOT_PASSWORD: { secret: true } }, initialDelay: 30, aliases: ['mariadb', 'maria'] },
    mongo: { image: 'mongo:7.0', port: 27017, probe: { tcp: true }, cpu: '200m', memory: '512Mi', limit: '1Gi', data: '/data/db', kind: 'StatefulSet', database: true,
        env: { MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: { secret: true } }, initialDelay: 20, aliases: ['mongo', 'mongodb'] },
    rabbitmq: { image: 'rabbitmq:3.13-management-alpine', port: 5672, extraPorts: [{ name: 'management', port: 15672 }], probe: { tcp: true }, cpu: '200m', memory: '256Mi', limit: '512Mi', data: '/var/lib/rabbitmq', kind: 'StatefulSet',
        env: { RABBITMQ_DEFAULT_USER: 'admin', RABBITMQ_DEFAULT_PASS: { secret: true } }, initialDelay: 30, aliases: ['rabbitmq', 'rabbit', 'amqp'] },
    // needs a database: KubeEZ adds MySQL when none is asked for, and links them (host + password from its Secret)
    wordpress: { image: 'wordpress:6.6-apache', port: 80, probe: { http: '/wp-login.php' }, cpu: '100m', memory: '128Mi', limit: '512Mi', data: '/var/www/html', initialDelay: 20,
        needsDb: ['mysql', 'mariadb'], env: { WORDPRESS_DB_HOST: { db: 'host' }, WORDPRESS_DB_USER: 'root', WORDPRESS_DB_PASSWORD: { db: 'password' }, WORDPRESS_DB_NAME: 'wordpress' }, aliases: ['wordpress', 'word press'] },
    adminer: { image: 'adminer:4.8.1', port: 8080, probe: { http: '/' }, cpu: '50m', memory: '64Mi', limit: '128Mi', aliases: ['adminer'] },
    whoami: { image: 'traefik/whoami:v1.10', port: 80, probe: { http: '/' }, cpu: '10m', memory: '16Mi', limit: '32Mi', aliases: ['whoami', 'echo server', 'demo app'] },
    busybox: { image: 'busybox:1.36', cpu: '10m', memory: '16Mi', limit: '64Mi', command: ['sh', '-c', 'echo "Hello from KubeEZ"; while true; do sleep 3600; done'], aliases: ['busybox'] },
    alpine: { image: 'alpine:3.20', cpu: '10m', memory: '16Mi', limit: '64Mi', command: ['sh', '-c', 'while true; do sleep 3600; done'], aliases: ['alpine'] },
    ubuntu: { image: 'ubuntu:24.04', cpu: '10m', memory: '32Mi', limit: '128Mi', command: ['sleep', 'infinity'], aliases: ['ubuntu'] },
    node: { image: 'node:22-alpine', base: true, command: ['sh', '-c', 'while true; do sleep 3600; done'], cpu: '100m', memory: '128Mi', limit: '512Mi', aliases: ['nodejs', 'node.js', 'node app', 'node js'] },
    python: { image: 'python:3.12-slim', base: true, command: ['sh', '-c', 'while true; do sleep 3600; done'], cpu: '100m', memory: '128Mi', limit: '512Mi', aliases: ['python', 'django', 'flask', 'fastapi'] }
}

// common image names → the catalog entry (for "image: nginx" written by a person or a model)
export const IMAGE_TO_APP = Object.fromEntries(Object.entries(APPS).map(([k, a]) => [a.image.split(':')[0], k]))
