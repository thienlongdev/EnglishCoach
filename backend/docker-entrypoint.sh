#!/bin/sh
# English Coach backend entrypoint: the application never runs as root.
#
# The container still STARTS as root for one reason: the storage volume (learner recordings, avatars, exam and
# community media) was created by earlier images that ran as root, and a volume keeps its owner. Before anything else
# this script hands the entries of that volume that the application user does not own yet to that user, then gives up
# root for good: the Java process runs as uid 10001 with an empty capability bounding set and no-new-privileges.
#
# The hand-over is not a blind recursive chown:
#   - only entries NOT already owned by the application user are touched (nothing to do on every later start, and a
#     period on an older, root-running image is repaired the same way after a rollback and roll-forward);
#   - symbolic links are changed themselves (-h), never the file they point to, and are never followed;
#   - nothing outside /app/storage is touched, and nothing is deleted, moved or rewritten.
# Rolling back to an image that runs as root needs nothing: root reads and writes files of any owner.
set -eu

APP_UID=10001
APP_GID=10001
STORAGE_DIR=/app/storage

if [ "$(id -u)" = "0" ]; then
    if [ -d "$STORAGE_DIR" ]; then
        if [ -n "$(find "$STORAGE_DIR" ! -uid "$APP_UID" -print -quit)" ]; then
            echo "[entrypoint] Handing entries of $STORAGE_DIR not owned by uid $APP_UID to the application user"
            find "$STORAGE_DIR" ! -uid "$APP_UID" -exec chown -h "$APP_UID:$APP_GID" {} +
            echo "[entrypoint] Storage ownership hand-over finished"
        fi
    fi
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
        --inh-caps=-all --bounding-set=-all --no-new-privs "$@"
fi

# Already unprivileged (the image was started with an explicit user): nothing to hand over, nothing to drop.
exec "$@"
