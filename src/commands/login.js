import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import inquirer from 'inquirer';
import { signIn, signUp, saveSession, getSession, logout, getSubscription, resetPassword, deleteAccount } from '../cloud/auth.js';

export async function loginCommand(options = {}) {
  const existing = await getSession();
  if (existing) {
    try {
      const sub = await getSubscription(existing);
      console.log('\n' + boxen(gradient.pastel('  memoir cloud  ') + '\n\n' + chalk.green('✔ Already logged in as ') + chalk.cyan(existing.user.email) + '\n' + chalk.gray('Plan: ') + (sub.status === 'pro' ? chalk.green('Pro') : chalk.yellow('Free')), { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n');
    } catch (error) {
      console.log('\n' + boxen(chalk.green('✔ Logged in as ') + chalk.cyan(existing.user.email) + '\n' + chalk.yellow('Plan could not be verified right now. No backup history will be pruned until it can be verified.') + '\n' + chalk.gray(error.message), { padding: 1, borderStyle: 'round', borderColor: 'yellow' }) + '\n');
    }
    return;
  }

  let action, email, password;
  if (options.email && options.password) { action = options.signup ? 'signup' : 'signin'; email = options.email; password = options.password; }
  else {
    console.log();
    action = (await inquirer.prompt([{ type: 'list', name: 'action', message: 'Sign in or create account?', choices: [{ name: 'Sign in (existing account)', value: 'signin' }, { name: 'Create account', value: 'signup' }] }])).action;
    email = (await inquirer.prompt([{ type: 'input', name: 'email', message: 'Email:', validate: v => v.includes('@') ? true : 'Enter a valid email' }])).email;
    password = (await inquirer.prompt([{ type: 'password', name: 'password', message: 'Password:', mask: '*', validate: v => v.length >= 6 ? true : 'Password must be at least 6 characters' }])).password;
  }

  try {
    let session;
    if (action === 'signup') {
      const result = await signUp(email, password);
      if (result.access_token) session = await saveSession(result);
      else { console.log('\n' + boxen(chalk.green('✔ Account created!') + '\n\n' + chalk.white('Check your email to confirm, then run ') + chalk.cyan('memoir login') + chalk.white(' again.'), { padding: 1, borderStyle: 'round', borderColor: 'green' }) + '\n'); return; }
    } else session = await saveSession(await signIn(email, password));

    let plan = 'Unknown';
    try { const sub = await getSubscription(session); plan = sub.status === 'pro' ? 'Pro' : 'Free'; } catch {}
    console.log('\n' + boxen(gradient.pastel('  memoir cloud  ') + '\n\n' + chalk.green('✔ Logged in as ') + chalk.cyan(session.user.email) + '\n' + chalk.gray('Plan: ') + (plan === 'Pro' ? chalk.green(plan) : plan === 'Free' ? chalk.yellow(plan) : chalk.yellow(plan + ' — will retry before retention cleanup')) + '\n\n' + chalk.gray('Try: ') + chalk.cyan('memoir cloud push') + chalk.gray(' to back up to the cloud'), { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n');
  } catch (error) { console.log('\n' + boxen(chalk.red('✖ ' + error.message), { padding: 1, borderStyle: 'round', borderColor: 'red' }) + '\n'); }
}

export async function forgotPasswordCommand(options = {}) {
  let email = options.email;
  if (!email) email = (await inquirer.prompt([{ type: 'input', name: 'email', message: 'Email:', validate: v => v.includes('@') ? true : 'Enter a valid email' }])).email;
  try { await resetPassword(email); console.log('\n' + boxen(chalk.green('✔ Password reset email sent!') + '\n\n' + chalk.white('Check ') + chalk.cyan(email) + chalk.white(' for a reset link.'), { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n'); }
  catch (error) { console.log('\n' + boxen(chalk.red('✖ ' + error.message), { padding: 1, borderStyle: 'round', borderColor: 'red' }) + '\n'); }
}

export async function logoutCommand() { await logout(); console.log('\n' + boxen(chalk.green('✔ Logged out'), { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n'); }

export async function deleteAccountCommand(options = {}) {
  const session = await getSession();
  if (!session) { console.log('\n' + boxen(chalk.red('✖ Not logged in. Run ') + chalk.cyan('memoir login') + chalk.red(' first.'), { padding: 1, borderStyle: 'round', borderColor: 'red' }) + '\n'); return; }
  if (!options.confirm) {
    const answer = await inquirer.prompt([{ type: 'input', name: 'confirmation', message: 'Type DELETE to remove your Memoir cloud data and sign out:' }]);
    if (answer.confirmation !== 'DELETE') { console.log('\n' + chalk.gray('  Account-data deletion cancelled.') + '\n'); return; }
  }
  try {
    await deleteAccount(session);
    console.log('\n' + boxen(gradient.pastel('  memoir cloud  ') + '\n\n' + chalk.green('✔ Memoir cloud data deleted and this device signed out.') + '\n' + chalk.gray('Backups, shared links, and subscription data accessible to this account were removed.') + '\n\n' + chalk.yellow('Your authentication identity may still exist. Full auth-account removal requires the hosted account-deletion service.'), { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n');
  } catch (error) { console.log('\n' + boxen(chalk.red('✖ Deletion incomplete: ' + error.message) + '\n' + chalk.gray('Retry the command. Memoir will not report success for an incomplete deletion.'), { padding: 1, borderStyle: 'round', borderColor: 'red' }) + '\n'); }
}
