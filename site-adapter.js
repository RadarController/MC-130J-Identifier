(() => {
  const adapt = () => {
    document.querySelectorAll('.serial-item').forEach((button) => {
      button.classList.add('button');
      if (button.classList.contains('active')) {
        button.classList.add('button-primary');
        button.classList.remove('button-secondary');
      } else {
        button.classList.add('button-secondary');
        button.classList.remove('button-primary');
      }
    });

    document.querySelectorAll('.badge').forEach((badge) => {
      badge.classList.add('text-link');
    });

    document.querySelectorAll('.image-card').forEach((card) => {
      card.classList.add('placeholder-card');
    });

    document.querySelectorAll('.image-card footer').forEach((footer) => {
      footer.classList.add('decision-text');
    });

    document.querySelectorAll('.image-card a').forEach((link) => {
      link.classList.add('text-link');
    });
  };

  let scheduled = false;
  const scheduleAdapt = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      adapt();
    });
  };

  adapt();

  new MutationObserver(scheduleAdapt).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
})();
