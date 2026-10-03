#!/bin/bash
# Verification script for CDK Project Setup (Task 1)
# This script validates that all components are properly configured

set -e

echo "=========================================="
echo "CDK Project Setup Verification"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

check_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

# Check 1: Directory structure
echo "1. Checking directory structure..."
if [ -d "bin" ] && [ -d "lib/config" ] && [ -d "lib/stacks" ]; then
    check_pass "Directory structure exists"
else
    check_fail "Directory structure incomplete"
fi

# Check 2: Required files exist
echo "2. Checking required files..."
required_files=(
    "bin/app.ts"
    "lib/config/environment.ts"
    "lib/stacks/api-stack.ts"
    "lib/stacks/storage-stack.ts"
    "lib/stacks/queue-stack.ts"
    "lib/stacks/monitoring-stack.ts"
    "cdk.json"
    "tsconfig.json"
    "package.json"
)

all_files_exist=true
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        echo "  Missing: $file"
        all_files_exist=false
    fi
done

if [ "$all_files_exist" = true ]; then
    check_pass "All required files exist"
else
    check_fail "Some required files are missing"
fi

# Check 3: TypeScript compilation
echo "3. Testing TypeScript compilation..."
if pnpm build > /dev/null 2>&1; then
    check_pass "TypeScript compiles successfully"
else
    check_fail "TypeScript compilation failed"
fi

# Check 4: CDK synth for dev environment
echo "4. Testing CDK synth for dev environment..."
if pnpm synth > /dev/null 2>&1; then
    check_pass "CDK synth (dev) successful"
else
    check_fail "CDK synth (dev) failed"
fi

# Check 5: CDK synth for staging environment
echo "5. Testing CDK synth for staging environment..."
if pnpm synth:staging > /dev/null 2>&1; then
    check_pass "CDK synth (staging) successful"
else
    check_fail "CDK synth (staging) failed"
fi

# Check 6: CDK synth for production environment
echo "6. Testing CDK synth for production environment..."
if pnpm synth:production > /dev/null 2>&1; then
    check_pass "CDK synth (production) successful"
else
    check_fail "CDK synth (production) failed"
fi

# Check 7: Stack listing
echo "7. Testing stack listing..."
stack_count=$(npx cdk list --context env=dev 2>&1 | grep "ClassroomIO-dev-" | wc -l | xargs)
if [ "$stack_count" -eq "4" ]; then
    check_pass "All 4 stacks listed correctly"
else
    check_fail "Expected 4 stacks, found $stack_count"
fi

# Check 8: Environment configurations
echo "8. Verifying environment configurations..."
if grep -q "dev" lib/config/environment.ts && \
   grep -q "staging" lib/config/environment.ts && \
   grep -q "production" lib/config/environment.ts; then
    check_pass "All environment configurations present"
else
    check_fail "Environment configurations incomplete"
fi

# Check 9: Dependencies installed
echo "9. Checking dependencies..."
if [ -d "node_modules/aws-cdk-lib" ] && \
   [ -d "node_modules/constructs" ] && \
   [ -d "node_modules/typescript" ]; then
    check_pass "Dependencies installed"
else
    check_fail "Dependencies missing"
fi

# Check 10: Generated CloudFormation templates
echo "10. Checking generated CloudFormation templates..."
if [ -d "cdk.out" ] && [ -f "cdk.out/manifest.json" ]; then
    check_pass "CloudFormation templates generated"
else
    check_fail "CloudFormation templates not generated"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}All checks passed!${NC}"
echo "=========================================="
echo ""
echo "Summary:"
echo "- TypeScript code compiles successfully"
echo "- CDK synthesizes for all environments (dev, staging, production)"
echo "- 4 stacks configured: Storage, Queue, API, Monitoring"
echo "- Environment configurations validated"
echo ""
echo "Task 1: CDK Project Setup - COMPLETE ✓"
