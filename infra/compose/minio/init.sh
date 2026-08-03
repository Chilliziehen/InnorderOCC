#!/bin/sh
set -eu

read_secret() {
  path="$1"
  if [ ! -r "$path" ]; then
    echo "Required secret file is not readable: $path" >&2
    return 1
  fi
  value="$(cat "$path")"
  if [ -z "$value" ]; then
    echo "Required secret file is empty: $path" >&2
    return 1
  fi
  printf '%s' "$value"
}

case "${MINIO_BUCKET:?MINIO_BUCKET is required}" in
  *[!a-z0-9.-]* | .* | *.)
    echo "MINIO_BUCKET is not a valid lowercase S3 bucket name" >&2
    exit 1
    ;;
esac

root_user="$(read_secret /run/secrets/minio_root_user)"
root_password="$(read_secret /run/secrets/minio_root_password)"
app_user="$(read_secret /run/secrets/minio_app_user)"
app_password="$(read_secret /run/secrets/minio_app_password)"

if [ "$root_user" = "$app_user" ] || [ "$root_password" = "$app_password" ]; then
  echo "MinIO root and application credentials must be distinct" >&2
  exit 1
fi

mc alias set local http://minio:9000 "$root_user" "$root_password"
mc mb --with-lock --ignore-existing "local/$MINIO_BUCKET"

cat > /tmp/occ-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutObjectRetention", "s3:GetObjectRetention"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET/*"]
    }
  ]
}
EOF

mc admin user add local "$app_user" "$app_password"
mc admin policy create local innorder-occ-app /tmp/occ-policy.json
mc admin policy attach local innorder-occ-app --user "$app_user"
