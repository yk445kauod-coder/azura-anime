"""S3-compatible object storage (Neon storage) helpers."""
from __future__ import annotations

from functools import lru_cache

import boto3
from botocore.config import Config

from . import config


@lru_cache(maxsize=1)
def client():
    return boto3.client(
        "s3",
        endpoint_url=config.S3_ENDPOINT,
        aws_access_key_id=config.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=config.AWS_SECRET_ACCESS_KEY,
        region_name=config.AWS_REGION,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                      retries={"max_attempts": 3, "mode": "standard"}),
    )


def key_for(source_id: str, kind: str, filename: str) -> str:
    return f"{config.S3_PREFIX}/{kind}/{source_id}/{filename}"


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    client().put_object(Bucket=config.S3_BUCKET, Key=key, Body=data, ContentType=content_type)
    return key


def get_bytes(key: str) -> bytes:
    return client().get_object(Bucket=config.S3_BUCKET, Key=key)["Body"].read()


def exists(key: str) -> bool:
    try:
        client().head_object(Bucket=config.S3_BUCKET, Key=key)
        return True
    except Exception:
        return False


def upload_file(local_path: str, key: str) -> str:
    client().upload_file(local_path, config.S3_BUCKET, key)
    return key
