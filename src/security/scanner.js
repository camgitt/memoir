import chalk from 'chalk';

// Patterns that match common secret formats
const SECRET_PATTERNS = [
  // API keys with known prefixes
  { regex: /\b(sk-[a-zA-Z0-9]{20,})/g, label: 'API key (sk-)' },
  { regex: /\b(sk-ant-[a-zA-Z0-9-]{20,})/g, label: 'Anthropic API key' },
  { regex: /\b(sk-proj-[a-zA-Z0-9-]{20,})/g, label: 'OpenAI API key' },
  { regex: /\b(ghp_[a-zA-Z0-9]{36,})/g, label: 'GitHub personal token' },
  { regex: /\b(gho_[a-zA-Z0-9]{36,})/g, label: 'GitHub OAuth token' },
  { regex: /\b(ghs_[a-zA-Z0-9]{36,})/g, label: 'GitHub server token' },
  { regex: /\b(github_pat_[a-zA-Z0-9_]{36,})/g, label: 'GitHub fine-grained token' },
  { regex: /\b(AIza[a-zA-Z0-9_-]{35})/g, label: 'Google API key' },
  { regex: /\b(AKIA[A-Z0-9]{16})/g, label: 'AWS access key' },
  { regex: /\b(xox[bpsa]-[a-zA-Z0-9-]{10,})/g, label: 'Slack token' },
  { regex: /\b(npx?_[a-zA-Z0-9]{30,})/g, label: 'npm token' },
  { regex: /\b(pypi-[a-zA-Z0-9]{50,})/g, label: 'PyPI token' },
  { regex: /\b(glpat-[a-zA-Z0-9_-]{20,})/g, label: 'GitLab token' },
  { regex: /\b(v2\.[a-zA-Z0-9]{20,})/g, label: 'Vercel token' },
  { regex: /\b(re_[a-zA-Z0-9]{20,})/g, label: 'Resend API key' },
  { regex: /\b(sq0[a-z]{3}-[a-zA-Z0-9_-]{22,})/g, label: 'Square token' },
  { regex: /\b(stripe[_-]?(?:sk|pk|rk)_(?:test_|live_)?[a-zA-Z0-9]{20,})/gi, label: 'Stripe key' },
  { regex: /\b(whsec_[a-zA-Z0-9]{20,})/g, label: 'Stripe webhook secret' },
  { regex: /\b(supabase[_-]?(?:anon|service)[_-]?key\s*[:=]\s*["']?eyJ[a-zA-Z0-9+/=]{50,})/gi, label: 'Supabase key' },

  // Connection strings
  { regex: /(postgres(?:ql)?:\/\/[^\s'"]{10,})/g, label: 'PostgreSQL connection string' },
  { regex: /(mysql:\/\/[^\s'"]{10,})/g, label: 'MySQL connection string' },
  { regex: /(mongodb(?:\+srv)?:\/\/[^\s'"]{10,})/g, label: 'MongoDB connection string' },
  { regex: /(redis:\/\/[^\s'"]{10,})/g, label: 'Redis connection string' },

  // Generic secrets in env/config patterns
  { regex: /(?:^|[\s;])(?:export\s+)?(?:API_KEY|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|DB_PASSWORD|DATABASE_URL|JWT_SECRET|ENCRYPTION_KEY|MASTER_KEY)\s*=\s*["']?([^\s'"]{8,})/gmi, label: 'Environment variable secret' },
  { regex: /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s'"]{6,})/gi, label: 'Password' },

  // Private keys
  { regex: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)/g, label: 'Private key' },

  // JWTs (eyJ... pattern)
  { regex: /\b(eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/g, label: 'JWT token' },
];

/**
 * Scan text for secrets and return findings
 * @param {string} text - Text to scan
 * @returns {{ found: Array<{label: string, match: string, redacted: string}>, clean: string }}
 */
export function scanForSecrets(text) {
  const findings = [];
  let clean = text;

  for (const pattern of SECRET_PATTERNS) {
    // Reset regex state
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const secret = match[1] || match[0];
      // Skip very short matches (likely false positives)
      if (secret.length < 8) continue;

      const redacted = secret.slice(0, 4) + '****' + secret.slice(-4);
      findings.push({
        label: pattern.label,
        match: secret,
        redacted
      });

      // Replace in clean text
      clean = clean.replaceAll(secret, `[REDACTED:${pattern.label}]`);
    }
  }

  // Deduplicate by match value
  const seen = new Set();
  const unique = findings.filter(f => {
    if (seen.has(f.match)) return false;
    seen.add(f.match);
    return true;
  });

  return { found: unique, clean };
}

/**
 * Redact secrets from text, returning clean version
 * @param {string} text - Text to redact
 * @returns {string} Clean text with secrets replaced
 */
export function redactSecrets(text) {
  return scanForSecrets(text).clean;
}

/**
 * Print a security report to console
 * @param {Array} findings - Array of findings from scanForSecrets
 */
export function printSecurityReport(findings) {
  if (findings.length === 0) {
    console.log(chalk.green('  🔒 No secrets detected'));
    return;
  }

  console.log(chalk.yellow(`  ⚠️  ${findings.length} potential secret(s) redacted:`));
  for (const f of findings) {
    console.log(chalk.gray(`     ${f.label}: ${f.redacted}`));
  }
}
