import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getSession } from '../cloud/auth.js';
import { listBackups } from '../cloud/storage.js';

export async function historyCommand() {
  const session = await getSession();
  if (!session) {
    console.log('\n' + boxen(
      chalk.red('✖ Not logged in') + '\n\n' +
      chalk.white('Run ') + chalk.cyan('memoir login') + chalk.white(' first.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  try {
    const backups = await listBackups(session);

    if (backups.length === 0) {
      console.log('\n' + boxen(
        chalk.yellow('No backups yet.') + '\n\n' +
        chalk.gray('Run ') + chalk.cyan('memoir cloud push') + chalk.gray(' to create your first backup.'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
      return;
    }

    console.log();

    const lines = backups.map((b, i) => {
      const date = new Date(b.created_at);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      const sizeStr = b.size_bytes < 1024
        ? `${b.size_bytes}B`
        : b.size_bytes < 1024 * 1024
          ? `${(b.size_bytes / 1024).toFixed(1)}KB`
          : `${(b.size_bytes / (1024 * 1024)).toFixed(1)}MB`;

      const latest = i === 0 ? chalk.green(' ← latest') : '';
      const machine = b.machine_name ? chalk.gray(` from ${b.machine_name}`) : '';

      return (
        chalk.white.bold(`  v${b.version}`) + `  ${dateStr} ${timeStr}` + latest + '\n' +
        chalk.gray(`      ${b.file_count} files, ${sizeStr}`) + machine + '\n' +
        chalk.gray(`      ${b.tools.join(', ')}`)
      );
    });

    console.log(boxen(
      gradient.pastel('  memoir history  ') + '\n\n' +
      chalk.gray(`${session.user.email} — ${backups.length} backup${backups.length !== 1 ? 's' : ''}`) + '\n\n' +
      lines.join('\n\n') + '\n\n' +
      chalk.gray('─'.repeat(36)) + '\n' +
      chalk.gray('Restore a version: ') + chalk.cyan('memoir cloud restore --version 3'),
      { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
    ) + '\n');

  } catch (error) {
    console.log('\n' + chalk.red('Error: ') + error.message + '\n');
  }
}
