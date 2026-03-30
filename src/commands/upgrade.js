import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import ora from 'ora';
import { getSession, getSubscription, supaFetch } from '../cloud/auth.js';
import { SUPABASE_URL } from '../cloud/constants.js';

async function createCheckoutSession(session) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/stripe-checkout`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create checkout session');
  return data.url;
}

function openUrl(url) {
  const { exec } = require('child_process');
  const platform = process.platform;
  if (platform === 'darwin') exec(`open "${url}"`);
  else if (platform === 'win32') exec(`start "" "${url}"`);
  else exec(`xdg-open "${url}"`);
}

export async function upgradeCommand() {
  const session = await getSession();
  let currentPlan = 'free';
  let email = null;

  if (session) {
    email = session.user.email;
    try {
      const sub = await getSubscription(session);
      currentPlan = sub.status === 'pro' ? 'pro' : 'free';
    } catch {
      // Fall through as free
    }
  }

  // Build comparison table
  const col1 = 22;
  const col2 = 22;

  const pad = (str, width) => {
    const stripped = str.replace(/\u001b\[[0-9;]*m/g, '');
    const diff = width - stripped.length;
    return diff > 0 ? str + ' '.repeat(diff) : str;
  };

  const freeLabel = currentPlan === 'free' ? 'Free (current)' : 'Free';
  const proLabel = currentPlan === 'pro' ? 'Pro (current)' : 'Pro $15/mo';
  const teamsLabel = 'Teams $29/seat';

  const header =
    pad(chalk.bold.white(freeLabel), col1) +
    pad(chalk.bold.cyan(proLabel), col2) +
    chalk.bold.magenta(teamsLabel);

  const sep = chalk.gray('─'.repeat(col1 + col2 + 18));

  const rows = [
    [chalk.gray('3 cloud backups'),   chalk.white('50 cloud backups'),   chalk.white('Unlimited backups')],
    [chalk.gray('Local only'),        chalk.white('Unlimited machines'), chalk.white('Shared team context')],
    [chalk.gray('Manual snapshots'),  chalk.white('Auto snapshots'),     chalk.white('Team dashboard')],
    [chalk.gray('Community support'), chalk.white('Priority support'),   chalk.white('Audit log')],
    [chalk.gray('—'),                 chalk.white('E2E encryption'),     chalk.white('SSO & RBAC')],
    [chalk.gray('—'),                 chalk.white('Version history'),    chalk.white('Priority onboarding')],
  ];

  const tableRows = rows.map(([a, b, c]) =>
    pad(a, col1) + pad(b, col2) + c
  ).join('\n');

  const table =
    '\n' + header + '\n' +
    sep + '\n' +
    tableRows + '\n';

  // Status line
  let statusLine;
  if (!session) {
    statusLine = chalk.yellow('Not logged in.') + chalk.gray(' Run ') + chalk.cyan('memoir login') + chalk.gray(' first.');
  } else if (currentPlan === 'pro') {
    statusLine = chalk.green('You\'re on Pro!') + ' ' + chalk.gray('Teams is coming soon — join the waitlist at memoir.sh/teams');
  } else {
    statusLine = chalk.gray('Logged in as ') + chalk.cyan(email);
  }

  console.log('\n' + boxen(
    gradient.pastel('  memoir upgrade  ') + '\n\n' +
    table + '\n' +
    statusLine,
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ));

  // If free and logged in, open Stripe checkout
  if (session && currentPlan === 'free') {
    const spinner = ora(chalk.cyan('  Creating checkout session...')).start();

    try {
      const url = await createCheckoutSession(session);
      spinner.succeed(chalk.green('  Opening Stripe checkout...'));

      const { exec } = await import('child_process');
      const platform = process.platform;
      if (platform === 'darwin') exec(`open "${url}"`);
      else if (platform === 'win32') exec(`start "" "${url}"`);
      else exec(`xdg-open "${url}"`);

      console.log(
        '\n' + chalk.gray('  Complete payment in your browser.') + '\n' +
        chalk.gray('  Your plan updates automatically — run ') +
        chalk.cyan('memoir upgrade') +
        chalk.gray(' again to verify.') + '\n'
      );
    } catch (err) {
      spinner.fail(chalk.red('  ' + err.message));
      console.log(chalk.gray('\n  Fallback: visit ') + chalk.cyan('https://memoir.sh/pricing') + '\n');
    }
  } else if (!session) {
    console.log('\n' + chalk.gray('  Run ') + chalk.cyan('memoir login') + chalk.gray(' to create an account, then ') + chalk.cyan('memoir upgrade') + chalk.gray(' to subscribe.') + '\n');
  } else {
    console.log();
  }
}
