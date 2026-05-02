#!/bin/bash
# ═══════════════════════════════════════════════════════════
# AgentDOM — AWS Deployment Script
# Deploys static docs to S3/CloudFront + API server to ECS
# ═══════════════════════════════════════════════════════════

set -e

# Config — change these
PROJECT="agentdom"
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
DOMAIN="agentdom.dev"  # Your domain (optional)

# Colors
G='\033[0;32m'; B='\033[0;34m'; Y='\033[1;33m'; R='\033[0;31m'; NC='\033[0m'
log() { echo -e "${G}[✓]${NC} $1"; }
info() { echo -e "${B}[→]${NC} $1"; }
warn() { echo -e "${Y}[!]${NC} $1"; }

echo ""
echo "  ⚡ AgentDOM AWS Deployment"
echo "  ─────────────────────────"
echo ""

# ─── STEP 1: Static Site → S3 ───
BUCKET="${PROJECT}-docs"
info "Creating S3 bucket: ${BUCKET}"

aws s3 mb "s3://${BUCKET}" --region ${REGION} 2>/dev/null || true

aws s3 website "s3://${BUCKET}" \
  --index-document index.html \
  --error-document index.html

# Upload static files
info "Uploading docs site..."
aws s3 sync ./docs/ "s3://${BUCKET}/docs/" \
  --delete \
  --cache-control "max-age=3600" \
  --content-type "text/html" \
  --exclude "*" --include "*.html"

aws s3 sync ./docs/ "s3://${BUCKET}/docs/" \
  --delete \
  --cache-control "max-age=86400" \
  --exclude "*.html"

# Upload main demo page + agentdom.js (for CDN)
aws s3 cp ./index.html "s3://${BUCKET}/index.html" \
  --cache-control "max-age=3600" \
  --content-type "text/html"

aws s3 cp ./agentdom.js "s3://${BUCKET}/v3/agentdom.min.js" \
  --cache-control "max-age=86400" \
  --content-type "application/javascript"

# Set bucket policy for public read
aws s3api put-bucket-policy --bucket ${BUCKET} --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"PublicRead\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::${BUCKET}/*\"
  }]
}"

log "Static site uploaded to S3"

# ─── STEP 2: CloudFront CDN ───
info "Creating CloudFront distribution..."

CF_CONFIG=$(cat <<EOF
{
  "CallerReference": "${PROJECT}-$(date +%s)",
  "Comment": "AgentDOM Docs CDN",
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-${BUCKET}",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    "ForwardedValues": {"QueryString": false, "Cookies": {"Forward": "none"}},
    "MinTTL": 0, "DefaultTTL": 86400, "MaxTTL": 31536000,
    "Compress": true
  },
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "S3-${BUCKET}",
      "DomainName": "${BUCKET}.s3.amazonaws.com",
      "S3OriginConfig": {"OriginAccessIdentity": ""}
    }]
  },
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "PriceClass": "PriceClass_100"
}
EOF
)

DIST_ID=$(aws cloudfront create-distribution \
  --distribution-config "${CF_CONFIG}" \
  --query 'Distribution.Id' --output text 2>/dev/null || echo "exists")

if [ "$DIST_ID" != "exists" ]; then
  log "CloudFront distribution created: ${DIST_ID}"
else
  warn "CloudFront distribution may already exist"
fi

# ─── STEP 3: Docker → ECR ───
ECR_REPO="${PROJECT}-api"
info "Creating ECR repository: ${ECR_REPO}"

aws ecr create-repository --repository-name ${ECR_REPO} --region ${REGION} 2>/dev/null || true

# Login to ECR
aws ecr get-login-password --region ${REGION} | \
  docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com

# Build and push
info "Building Docker image..."
docker build -t ${ECR_REPO} .

docker tag ${ECR_REPO}:latest ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest

info "Pushing to ECR..."
docker push ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest

log "Docker image pushed to ECR"

# ─── STEP 4: ECS Fargate ───
CLUSTER="${PROJECT}-cluster"
SERVICE="${PROJECT}-api"
TASK_DEF="${PROJECT}-task"

info "Creating ECS cluster: ${CLUSTER}"
aws ecs create-cluster --cluster-name ${CLUSTER} --region ${REGION} 2>/dev/null || true

# Register task definition
info "Registering task definition..."
aws ecs register-task-definition \
  --family ${TASK_DEF} \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu "1024" \
  --memory "2048" \
  --execution-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole" \
  --container-definitions "[{
    \"name\": \"${PROJECT}\",
    \"image\": \"${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest\",
    \"portMappings\": [{\"containerPort\": 3700, \"protocol\": \"tcp\"}],
    \"environment\": [
      {\"name\": \"PORT\", \"value\": \"3700\"},
      {\"name\": \"NODE_ENV\", \"value\": \"production\"}
    ],
    \"logConfiguration\": {
      \"logDriver\": \"awslogs\",
      \"options\": {
        \"awslogs-group\": \"/ecs/${PROJECT}\",
        \"awslogs-region\": \"${REGION}\",
        \"awslogs-stream-prefix\": \"ecs\"
      }
    },
    \"essential\": true
  }]"

log "Task definition registered"

echo ""
echo "  ═══════════════════════════════════════════"
echo "  ✅ Deployment Complete!"
echo "  ═══════════════════════════════════════════"
echo ""
echo "  📄 Docs:  https://${BUCKET}.s3.amazonaws.com/docs/index.html"
echo "  🔧 API:   Will be available after ECS service starts"
echo "  📦 CDN:   https://cdn.agentdom.dev/v3/agentdom.min.js"
echo ""
echo "  Next steps:"
echo "  1. Create VPC + subnets for ECS (if not exists)"
echo "  2. Create ALB target group + listener"
echo "  3. Create ECS service with: aws ecs create-service"
echo "  4. Point Route53 to CloudFront + ALB"
echo "  5. Set OPENROUTER_API_KEY in Secrets Manager"
echo ""
