# AgentDOM — AWS Architecture

## Overview

```
                    ┌─────────────────────────────────────────┐
                    │              Route 53                     │
                    │   agentdom.dev → CloudFront + ALB        │
                    └──────┬───────────────┬──────────────────┘
                           │               │
              ┌────────────▼───┐   ┌───────▼──────────┐
              │  CloudFront    │   │  ALB (Load        │
              │  (CDN)         │   │  Balancer)        │
              │                │   │  api.agentdom.dev │
              └────────┬───────┘   └───────┬──────────┘
                       │                   │
              ┌────────▼───────┐   ┌───────▼──────────┐
              │  S3 Bucket     │   │  ECS Fargate      │
              │  Static Files  │   │  (Node.js API)    │
              │  ─────────     │   │  ──────────       │
              │  docs/         │   │  HTTP Server :3700│
              │  agentdom.js   │   │  A2A Server  :3800│
              │  CRM demo      │   │  + Puppeteer      │
              │  index.html    │   │  + Chromium        │
              └────────────────┘   └──────────────────┘
```

## AWS Services Used

| Service | Purpose | Cost |
|---------|---------|------|
| **S3** | Host static docs, agentdom.js CDN, CRM demo | ~$0.02/mo |
| **CloudFront** | CDN for global delivery, HTTPS | ~$1/mo |
| **ECR** | Docker image registry | ~$0.10/mo |
| **ECS Fargate** | Run Node.js API + Puppeteer | ~$15-30/mo |
| **ALB** | Load balancer for API | ~$16/mo |
| **Route 53** | DNS for agentdom.dev | ~$0.50/mo |
| **Secrets Manager** | Store OPENROUTER_API_KEY | ~$0.40/mo |
| **CloudWatch** | Logs + monitoring | ~$1/mo |

**Estimated total: ~$35-50/month**

## Quick Deploy Steps

### Prerequisites
```bash
# Install AWS CLI
brew install awscli

# Configure
aws configure
# Enter: Access Key, Secret Key, Region (us-east-1)
```

### Step 1: Deploy Static Site (Docs + CDN)
```bash
# Create S3 bucket
aws s3 mb s3://agentdom-docs --region us-east-1

# Upload docs
aws s3 sync ./docs/ s3://agentdom-docs/docs/ --delete
aws s3 cp ./agentdom.js s3://agentdom-docs/v3/agentdom.min.js
aws s3 cp ./index.html s3://agentdom-docs/index.html

# Enable static hosting
aws s3 website s3://agentdom-docs --index-document index.html

# Your docs are now live at:
# http://agentdom-docs.s3-website-us-east-1.amazonaws.com
```

### Step 2: Deploy API Server (Docker → ECS)
```bash
# Build Docker image
docker build -t agentdom-api .

# Test locally first
docker run -p 3700:3700 -e OPENROUTER_API_KEY=sk-... agentdom-api

# Push to ECR
aws ecr create-repository --repository-name agentdom-api
aws ecr get-login-password | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com
docker tag agentdom-api:latest <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/agentdom-api:latest
docker push <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/agentdom-api:latest

# Create ECS cluster + service
aws ecs create-cluster --cluster-name agentdom
# Then create service via AWS Console or CLI (see deploy-aws.sh)
```

### Step 3: Connect Domain
```bash
# Point agentdom.dev to CloudFront (docs)
# Point api.agentdom.dev to ALB (API server)
```

## Alternative: Simpler Deploy with Vercel + Railway

If AWS feels heavy, you can split it:

| Component | Platform | Command |
|-----------|----------|---------|
| Docs site | **Vercel** | `vercel --prod` (free) |
| API server | **Railway** | `railway up` (~$5/mo) |
| agentdom.js CDN | **jsDelivr** | Free via npm |

```bash
# Option A: Vercel for docs (free)
cd docs && vercel --prod

# Option B: Railway for API ($5/mo)
railway init && railway up
```

## Environment Variables (ECS)

Set these in ECS Task Definition or Secrets Manager:

```
OPENROUTER_API_KEY=sk-or-...     # Required for AI features
OPENROUTER_MODEL=google/gemini-2.0-flash-001
AGENTDOM_API_KEY=your-api-key    # Optional: protect your API
PORT=3700
A2A_PORT=3800
NODE_ENV=production
```
