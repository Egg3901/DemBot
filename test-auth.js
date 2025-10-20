const { authenticateAndNavigate } = require('./lib/ppusa-auth');

console.log('Testing PPUSA auth with enhanced error reporting...');

authenticateAndNavigate({ url: '/national/states' }).then(result => {
  console.log('✅ Auth successful! Final URL:', result.finalUrl);
  result.browser.close();
  process.exit(0);
}).catch(err => {
  console.log('❌ Auth failed with enhanced error info:');
  console.log('Error:', err.message);

  if (err.details?.debugInfo) {
    console.log('Debug info:', JSON.stringify(err.details.debugInfo, null, 2));
  }

  if (err.details?.actions) {
    console.log('Last few steps:');
    err.details.actions.slice(-5).forEach((action, i) => {
      console.log(`  ${i+1}. ${action.step} - ${action.success ? '✅' : '❌'}`);
      if (action.finalUrl) console.log(`     URL: ${action.finalUrl}`);
    });
  }

  process.exit(1);
});
