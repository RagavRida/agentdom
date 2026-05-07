#!/bin/bash
# AgentDOM AWS Deploy — one script, full stack
# Usage: ./deploy.sh [your-openrouter-key]
set -e

OPENROUTER_KEY=${1:-$OPENROUTER_API_KEY}
REGION=${AWS_REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo ""
echo "  ◆ AgentDOM AWS Deploy"
echo "  ─────────────────────────────────"
echo "  Account : $ACCOUNT"
echo "  Region  : $REGION"
echo "  API Key : ${OPENROUTER_KEY:0:12}..."
echo ""

# 1. Install CDK if missing
if ! command -v cdk &> /dev/null; then
  echo "  → Installing AWS CDK..."
  npm install -g aws-cdk
fi

# 2. Install CDK dependencies
if [ ! -d "node_modules/aws-cdk-lib" ]; then
  echo "  → Installing CDK dependencies..."
  npm install --save-dev \
    aws-cdk \
    aws-cdk-lib \
    constructs
fi

# 3. Bootstrap CDK (only needed once per account/region)
echo "  → Bootstrapping CDK..."
npx cdk bootstrap aws://$ACCOUNT/$REGION

# 4. Deploy full stack
echo "  → Deploying AgentDOM stack..."
npx cdk deploy AgentDOMStack \
  --context apiKey="$OPENROUTER_KEY" \
  --require-approval never \
  --outputs-file aws/cdk-outputs.json

# 5. Print outputs
echo ""
echo "  ─────────────────────────────────"
echo "  ✓ Deployment complete!"
echo ""
if [ -f aws/cdk-outputs.json ]; then
  API=$(node -e "const o=require('./aws/cdk-outputs.json').AgentDOMStack; console.log(o.APIEndpoint)")
  CDN=$(node -e "const o=require('./aws/cdk-outputs.json').AgentDOMStack; console.log(o.CDNEndpoint)")
  echo "  API Server  : $API"
  echo "  CDN / Docs  : $CDN"
  echo "  Health      : $API/health"
  echo "  OpenAPI     : $API/openapi.json"
  echo ""
  echo "  Test it:"
  echo "    curl $API/health"
  echo "    curl -X POST $API/browse -H 'Content-Type: application/json' \\"
  echo "         -d '{\"url\":\"https://news.ycombinator.com\"}'"
fi
echo ""
