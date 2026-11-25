const demo = document.querySelector('#receipt-demo');
if (demo) {
  const recipients = [...demo.querySelectorAll('[data-recipient]')];
  const verify = demo.querySelector('[data-verify]');
  const reset = demo.querySelector('[data-reset]');
  const status = demo.querySelector('[role="status"]');
  let verified = 0;

  function render() {
    const closed = verified === recipients.length;
    for (const [index, recipient] of recipients.entries()) {
      const saved = index < verified;
      recipient.textContent = saved ? 'Verified save' : 'Waiting';
      recipient.classList.toggle('verified', saved);
    }
    verify.disabled = closed;
    reset.disabled = verified === 0;
    status.textContent = closed ? 'Closed. All three saved copies were verified.' : `Open for pickup. ${verified} of ${recipients.length} verified.`;
  }

  verify.addEventListener('click', () => {
    verified = Math.min(verified + 1, recipients.length);
    render();
    if (verify.disabled) reset.focus();
  });
  reset.addEventListener('click', () => {
    verified = 0;
    render();
    verify.focus();
  });
  render();
  demo.querySelector('[data-fallback]').hidden = true;
  demo.querySelector('.actions').hidden = false;
}
