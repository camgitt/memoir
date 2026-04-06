import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import inquirer from 'inquirer';
import { signIn, signUp, saveSession, getSession, logout, getSubscription, resetPassword, deleteAccount } from '../cloud/auth.js';

export async function loginCommand(options = {}) {
  // Check if already logged in
  const existing = await getSession();
  if (existing) {
    const sub = await getSubscription(existing);
    console.log('\n' + boxen(
      gradient.pastel('  memoir cloud  ') + '\n\n' +
      chalk.green('✔ Already logged in as ') + chalk.cyan(existing.user.email) + '\n' +
      chalk.gray('Plan: ') + (sub.status === 'pro' ? chalk.green('Pro') : chalk.yellow('Free')),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');
    return;
  }

  let action, email, password;

  // Support non-interactive login via flags
  if (options.email && options.password) {
    action = options.signup ? 'signup' : 'signin';
    email = options.email;
    password = options.password;
  } else {
    console.log();

    const actionAnswer = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Sign in or create account?',
      choices: [
        { name: 'Sign in (existing account)', value: 'signin' },
        { name: 'Create account', value: 'signup' },
      ],
    }]);
    action = actionAnswer.action;

    const emailAnswer = await inquirer.prompt([{
      type: 'input',
      name: 'email',
      message: 'Email:',
      validate: v => v.includes('@') ? true : 'Enter a valid email',
    }]);
    email = emailAnswer.email;

    const passwordAnswer = await inquirer.prompt([{
      type: 'password',
      name: 'password',
      message: 'Password:',
      mask: '*',
      validate: v => v.length >= 6 ? true : 'Password must be at least 6 characters',
    }]);
    password = passwordAnswer.password;
  }

  try {
    let session;

    if (action === 'signup') {
      const result = await signUp(email, password);
      if (result.access_token) {
        session = await saveSession(result);
      } else {
        // Email confirmation required
        console.log('\n' + boxen(
          chalk.green('✔ Account created!') + '\n\n' +
          chalk.white('Check your email to confirm, then run ') + chalk.cyan('memoir login') + chalk.white(' again.'),
          { padding: 1, borderStyle: 'round', borderColor: 'green' }
        ) + '\n');
        return;
      }
    } else {
      const result = await signIn(email, password);
      session = await saveSession(result);
    }

    const sub = await getSubscription(session);

    console.log('\n' + boxen(
      gradient.pastel('  memoir cloud  ') + '\n\n' +
      chalk.green('✔ Logged in as ') + chalk.cyan(session.user.email) + '\n' +
      chalk.gray('Plan: ') + (sub.status === 'pro' ? chalk.green('Pro') : chalk.yellow('Free')) + '\n\n' +
      chalk.gray('Try: ') + chalk.cyan('memoir cloud push') + chalk.gray(' to back up to the cloud'),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');

  } catch (error) {
    console.log('\n' + boxen(
      chalk.red('✖ ' + error.message),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
  }
}

export async function forgotPasswordCommand(options = {}) {
  let email = options.email;

  if (!email) {
    const emailAnswer = await inquirer.prompt([{
      type: 'input',
      name: 'email',
      message: 'Email:',
      validate: v => v.includes('@') ? true : 'Enter a valid email',
    }]);
    email = emailAnswer.email;
  }

  try {
    await resetPassword(email);
    console.log('\n' + boxen(
      chalk.green('✔ Password reset email sent!') + '\n\n' +
      chalk.white('Check ') + chalk.cyan(email) + chalk.white(' for a reset link.'),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');
  } catch (error) {
    console.log('\n' + boxen(
      chalk.red('✖ ' + error.message),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
  }
}

export async function logoutCommand() {
  await logout();
  console.log('\n' + boxen(
    chalk.green('✔ Logged out'),
    { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
  ) + '\n');
}

export async function deleteAccountCommand(options = {}) {
  const session = await getSession();
  if (!session) {
    console.log('\n' + boxen(
      chalk.red('✖ Not logged in. Run ') + chalk.cyan('memoir login') + chalk.red(' first.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  if (!options.confirm) {
    const answer = await inquirer.prompt([{
      type: 'input',
      name: 'confirmation',
      message: 'Type DELETE to confirm account deletion:',
    }]);

    if (answer.confirmation !== 'DELETE') {
      console.log('\n' + chalk.gray('  Account deletion cancelled.') + '\n');
      return;
    }
  }

  try {
    await deleteAccount(session);

    console.log('\n' + boxen(
      gradient.pastel('  memoir cloud  ') + '\n\n' +
      chalk.green('✔ Account deleted.') + '\n' +
      chalk.gray('All backups, shared links, and data have been removed.'),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');
  } catch (error) {
    console.log('\n' + boxen(
      chalk.red('✖ ' + error.message),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
  }
}
