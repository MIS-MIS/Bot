const { exec } = require('child_process');

console.log('Installing/updating dependencies...');
exec('npm install && npm update', (error, stdout, stderr) => {
  if (error) {
    console.error(`exec error: ${error}`);
    return;
  }
  console.log(`stdout: ${stdout}`);
  console.error(`stderr: ${stderr}`);
  console.log('Dependencies installed/updated successfully.');
});