import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getSession, getSubscription } from '../cloud/auth.js';

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
    // Strip ANSI for length calculation
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

  // If free and logged in, open pricing page
  if (session && currentPlan === 'free') {
    console.log('\n' + chalk.cyan('  Opening pricing page...') + '\n');

    const { exec } = await import('child_process');
    const url = 'https://memoir.sh/pricing';

    const platform = process.platform;
    let cmd;
    if (platform === 'darwin') {
      cmd = `open "${url}"`;
    } else if (platform === 'win32') {
      cmd = `start "${url}"`;
    } else {
      cmd = `xdg-open "${url}"`;
    }

    exec(cmd, () => {});

    console.log(
      chalk.gray('  Once you\'ve completed payment, run ') +
      chalk.cyan('memoir login') +
      chalk.gray(' to refresh your plan.') + '\n'
    );
  } else if (!session) {
    console.log('\n' + chalk.gray('  Sign up at ') + chalk.cyan('memoir.sh/pricing') + chalk.gray(' or run ') + chalk.cyan('memoir login') + chalk.gray(' to get started.') + '\n');
  } else {
    console.log();
  }
}
