#!/bin/bash
# Secret scanning script for pre-commit hook
# Scans staged files for potential secrets before commit

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Scanning for secrets in staged files..."

# Get list of staged files (excluding deleted files)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    echo -e "${GREEN}No staged files to scan.${NC}"
    exit 0
fi

# Patterns to detect secrets
PATTERNS=(
    # API Keys
    'sk-[a-zA-Z0-9]{20,}'                           # OpenAI/Anthropic style
    'sk-ant-[a-zA-Z0-9-]+'                          # Anthropic API key
    'sk_live_[0-9a-zA-Z]{24}'                       # Stripe live key
    'sk_test_[0-9a-zA-Z]{24}'                       # Stripe test key
    'AKIA[0-9A-Z]{16}'                              # AWS Access Key
    'AIza[0-9A-Za-z_-]{35}'                         # Google API Key
    'ghp_[a-zA-Z0-9]{36}'                           # GitHub Personal Access Token
    'github_pat_[a-zA-Z0-9_]{22,}'                  # GitHub Fine-grained PAT
    'gho_[a-zA-Z0-9]{36}'                           # GitHub OAuth Token
    'xox[baprs]-[0-9a-zA-Z-]+'                      # Slack tokens

    # Private keys
    '-----BEGIN (RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY'
    '-----BEGIN CERTIFICATE-----'

    # Database URLs with credentials
    'mongodb(\+srv)?://[^"\s]+:[^@"\s]+@'
    'postgres(ql)?://[^"\s]+:[^@"\s]+@'
    'mysql://[^"\s]+:[^@"\s]+@'
    'redis://[^"\s]+:[^@"\s]+@'

    # JWT tokens (long base64 with dots)
    'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'

    # Supabase keys (JWT format)
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}'

    # Generic secrets (with context)
    'password\s*[:=]\s*["\047][^"\047]{8,}["\047]'
    'secret\s*[:=]\s*["\047][^"\047]{8,}["\047]'
    'api[_-]?key\s*[:=]\s*["\047][^"\047]{16,}["\047]'
)

FOUND_SECRETS=0
ISSUES=""

for file in $STAGED_FILES; do
    # Skip binary files and certain file types
    if [[ "$file" =~ \.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz)$ ]]; then
        continue
    fi

    # Skip if file doesn't exist (might be a rename)
    if [ ! -f "$file" ]; then
        continue
    fi

    # Skip node_modules and dist
    if [[ "$file" =~ ^node_modules/ ]] || [[ "$file" =~ ^dist/ ]]; then
        continue
    fi

    for pattern in "${PATTERNS[@]}"; do
        # Use grep to find matches
        MATCHES=$(grep -n -E "$pattern" "$file" 2>/dev/null || true)

        if [ -n "$MATCHES" ]; then
            # Filter out false positives (example files, documentation, variable names)
            FILTERED=$(echo "$MATCHES" | grep -v -E '(\.example|\.sample|\.md:|your-|placeholder|xxx|TODO|CHANGEME|process\.env\.|\.env\.)' || true)

            if [ -n "$FILTERED" ]; then
                FOUND_SECRETS=1
                ISSUES="${ISSUES}\n${YELLOW}File: ${file}${NC}\n"
                while IFS= read -r line; do
                    LINE_NUM=$(echo "$line" | cut -d: -f1)
                    CONTENT=$(echo "$line" | cut -d: -f2-)
                    # Truncate long lines and mask potential secrets
                    MASKED=$(echo "$CONTENT" | sed -E 's/(sk-[a-zA-Z0-9]{4})[a-zA-Z0-9]+/\1***/g' | cut -c1-80)
                    ISSUES="${ISSUES}  Line ${LINE_NUM}: ${MASKED}...\n"
                done <<< "$FILTERED"
            fi
        fi
    done
done

if [ $FOUND_SECRETS -eq 1 ]; then
    echo -e "${RED}POTENTIAL SECRETS DETECTED!${NC}"
    echo -e "${RED}================================${NC}"
    echo -e "$ISSUES"
    echo -e "${RED}================================${NC}"
    echo -e "${YELLOW}If these are false positives, you can:${NC}"
    echo -e "  1. Add them to .secretsignore (create if needed)"
    echo -e "  2. Use 'git commit --no-verify' to skip this check (NOT RECOMMENDED)"
    echo -e ""
    echo -e "${RED}Commit blocked to protect you from leaking secrets.${NC}"
    exit 1
fi

echo -e "${GREEN}No secrets detected. Commit allowed.${NC}"
exit 0
