BUCKET_NAME=${1:-crs-backend-dev-status-list}

aws s3api put-object \
  --bucket "${BUCKET_NAME}" \
  --key b/A671FED3E9AD \
  --body ../resources/b/A671FED3E9AD \
  --content-type text/plain

aws s3api put-object \
  --bucket "${BUCKET_NAME}" \
  --key t/3B0F3BD087A7 \
  --body ../resources/t/3B0F3BD087A7 \
  --content-type text/plain
