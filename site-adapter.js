(() => {
  const serialList = document.querySelector('#serial-list');
  const serialSelect = document.querySelector('#serial-select');

  if (!serialList || !serialSelect) return;

  const getButtonLabel = (button) => {
    const serial = button.querySelector('strong')?.textContent?.trim() || button.dataset.serial || 'Unknown serial';
    const meta = button.querySelector('small')?.textContent?.trim();
    return meta ? `${serial} — ${meta.replace(/\s*\|\s*/g, ' • ')}` : serial;
  };

  const getEscapedSerialSelector = (serial) => {
    if (window.CSS && typeof CSS.escape === 'function') {
      return `.serial-item[data-serial="${CSS.escape(serial)}"]`;
    }
    return `.serial-item[data-serial="${String(serial).replace(/"/g, '\\"')}"]`;
  };

  const syncSerialDropdown = () => {
    const buttons = Array.from(serialList.querySelectorAll('.serial-item'));
    const activeSerial = buttons.find((button) => button.classList.contains('active'))?.dataset.serial;
    const previousValue = serialSelect.value;
    const nextValue = activeSerial || previousValue || buttons[0]?.dataset.serial || '';

    serialSelect.innerHTML = '';

    buttons.forEach((button) => {
      const option = document.createElement('option');
      option.value = button.dataset.serial || '';
      option.textContent = getButtonLabel(button);
      serialSelect.appendChild(option);
    });

    if (nextValue && Array.from(serialSelect.options).some((option) => option.value === nextValue)) {
      serialSelect.value = nextValue;
    }
  };

  serialSelect.addEventListener('change', () => {
    const button = serialList.querySelector(getEscapedSerialSelector(serialSelect.value));
    if (button) button.click();
  });

  const observer = new MutationObserver(syncSerialDropdown);
  observer.observe(serialList, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  syncSerialDropdown();
})();
