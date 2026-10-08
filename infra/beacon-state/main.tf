# Beacon deploy-state bucket: the durable history the S3 deploy-state store
# records to. Two-deep history per (service@environment), one JSON object each
# (see packages/beacon/src/state.ts — S3DeployStateStore).

variable "bucket_name" {
  type        = string
  description = "The name for the Beacon deploy-state bucket (must not collide with any existing bucket)."
}

variable "kms_key_arn" {
  type        = string
  default     = null
  description = "An existing KMS key ARN for at-rest AWS KMS encryption. Defaults to AES256; do not ship a NEW key in this module: the key's policies are estate-level."
}

variable "retention_days" {
  type        = number
  default     = 30
  description = "The GOVERNANCE retention for newly written deploy-state objects (the two-deep window and any rollback record are re-read within days, never silently rewritten after)."
}

# The S3 bucket's four attributes:
# - versioning: every overwrite is recoverable —
#   the conditional put's loser is a sibling's acknowledged record;

resource "aws_s3_bucket" "beacon_state" {
  bucket        = var.bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "beacon_state" {
  bucket = aws_s3_bucket.beacon_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# The deploy-state history is Beacon's rollback record: an AES-256 default at
# rest (the estate's key-management decision stays open) and bucket-key
# enabled to hobble the KMS per-request cost.
resource "aws_s3_bucket_server_side_encryption_configuration" "beacon_state" {
  bucket = aws_s3_bucket.beacon_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

# No public surface, no cross-account object scan, no mild default ownership.
resource "aws_s3_bucket_public_access_block" "beacon_state" {
  bucket                  = aws_s3_bucket.beacon_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "beacon_state" {
  bucket = aws_s3_bucket.beacon_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# The record immutability itself: the deploy-state object is Beacon's writing
# hand and a rollback's source-of-truth; object-lock protects GOVERNANCE
# retention for writes within window while operators can still escape-hatch
# administratively. (Object lock requires versioning; the versioning
# dependency is declared so the control lands after the bucket's own.)
resource "aws_s3_bucket_object_lock_configuration" "beacon_state" {
  bucket = aws_s3_bucket.beacon_state.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.retention_days
    }
  }

  # The .tf scan reads the bucket as a dependency (versioning) before
  # configuring the lock configuration, because object lock REQUIRES it.
  depends_on = [aws_s3_bucket_versioning.beacon_state]
}

# Blanket deny-delete: even a compromised writer never loses history silently.
# This is NOT the object-lock escape hatch (that one is explicitly granted);
# it protects the deploy-state objects' history from ACCIDENTAL destruction.
resource "aws_s3_bucket_policy" "deny_delete" {
  bucket = aws_s3_bucket.beacon_state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyDeleteObject"
        Effect    = "Deny"
        Principal = "*"
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:AbortMultipartUpload",
        ]
        Resource = [
          "${aws_s3_bucket.beacon_state.arn}",
          "${aws_s3_bucket.beacon_state.arn}/*",
        ]
      },
    ]
  })
}

output "bucket_arn" {
  description = "The deploy-state bucket's ARN (grant the Beacon identity s3:GetObject/PutObject IT only; deletes never apply)."
  value       = aws_s3_bucket.beacon_state.arn
}

output "bucket_name" {
  description = "The deploy-state bucket's name (BEACON_STATE_BUCKET)."
  value       = aws_s3_bucket.beacon_state.id
}
