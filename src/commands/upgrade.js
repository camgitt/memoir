import { execFile } from 'child_process';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import ora from 'ora';
import { getSession, getSubscription, supaFetch } from '../cloud/auth.js';
import { SUPABASE_URL, MAX_BACKUPS_FREE, MAX_BACKUPS_PRO } from '../cloud/constants.js';

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

// No shell interpolation: execFile passes the URL as a discrete argument
// array; on Windows rundll32's URL handler avoids cmd.exe parsing `&` inside
// the query string.
function openUrl(url) {
  const platform = process.platform;
  const [cmd, args] = platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  try { execFile(cmd, args, () => {}); } catch {}
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
  const teamsLabel = 'Teams (coming soon)';

  const header =
    pad(chalk.bold.white(freeLabel), col1) +
    pad(chalk.bold.cyan(proLabel), col2) +
    chalk.bold.magenta(teamsLabel);

  const sep = chalk.gray('─'.repeat(col1 + col2 + 18));

  const rows = [
    [chalk.gray(`${MAX_BACKUPS_FREE} retained backups`), chalk.white(`${MAX_BACKUPS_PRO} retained backups`), chalk.white(`${MAX_BACKUPS_PRO} retained backups`)],
    [chalk.gray('Community support'),  chalk.white('Sync across machines'), chalk.white('Shared team context')],
    [chalk.white('E2E encryption'),    chalk.white('E2E encryption'),       chalk.white('E2E encryption')],
    [chalk.gray('—'),                  chalk.gray('—'),                    chalk.white('Team dashboard')],
    [chalk.gray('—'),                  chalk.gray('—'),                    chalk.white('Audit log')],
    [chalk.gray('—'),                  chalk.gray('—'),                    chalk.white('SSO & RBAC')],
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

      openUrl(url);

      console.log(
        '\n' + chalk.gray('  Complete payment in your browser.') + '\n' +
        chalk.gray('  Your plan updates automatically — run ') +
        chalk.cyan('memoir upgrade') +
        chalk.gray(' again to verify.') + '\n'
      );
    } catch (err) {
      spinner.fail(chalk.red('  ' + err.message));
      console.log(chalk.gray('\n  Fallback: visit ') + chalk.cyan('https://memoir.sh/#pricing') + '\n');
    }
  } else if (!session) {
    console.log('\n' + chalk.gray('  Run ') + chalk.cyan('memoir login') + chalk.gray(' to create an account, then ') + chalk.cyan('memoir upgrade') + chalk.gray(' to subscribe.') + '\n');
  } else {
    console.log();
  }
}
