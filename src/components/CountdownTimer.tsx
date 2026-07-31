import { html } from 'hono/html';

const UNITS = [
  { key: 'days', label: 'Days' },
  { key: 'hours', label: 'Hours' },
  { key: 'minutes', label: 'Min' },
  { key: 'seconds', label: 'Sec' },
] as const;

export function CountdownTimer({
  targetDate,
  showTitle,
}: {
  targetDate: string;
  showTitle: string;
}) {
  return (
    <div
      class="countdown-timer bg-white/10 backdrop-blur-sm rounded-2xl p-8 text-center max-w-sm"
      data-target={targetDate}
      aria-label={`Countdown to ${showTitle} opening night`}
    >
      <p class="text-white/70 text-sm uppercase tracking-wider mb-4">Opening Night In</p>

      <div class="grid grid-cols-4 gap-4">
        {UNITS.map((unit) => (
          <div class="countdown-unit">
            <div class="bg-white/20 rounded-xl p-4">
              <span
                class={`countdown-${unit.key} font-display text-3xl lg:text-4xl font-bold text-white block`}
              >
                --
              </span>
            </div>
            <span class="text-white/60 text-xs uppercase mt-2 block">{unit.label}</span>
          </div>
        ))}
      </div>

      <p class="countdown-ended hidden text-accent-400 font-semibold mt-4">
        The show has opened!
      </p>
    </div>
  );
}

export const countdownScript = () => html`
  <script>
    document.querySelectorAll('.countdown-timer').forEach(function (timer) {
      var targetDate = timer.getAttribute('data-target');
      if (!targetDate) return;

      // Curtain is 7:00 PM local time on the opening date.
      var target = new Date(targetDate + 'T19:00:00').getTime();
      var els = {
        days: timer.querySelector('.countdown-days'),
        hours: timer.querySelector('.countdown-hours'),
        minutes: timer.querySelector('.countdown-minutes'),
        seconds: timer.querySelector('.countdown-seconds'),
      };
      var ended = timer.querySelector('.countdown-ended');
      var interval;

      function pad(n) {
        return String(n).padStart(2, '0');
      }

      function update() {
        var distance = target - Date.now();
        if (distance < 0) {
          Object.keys(els).forEach(function (k) {
            if (els[k]) els[k].textContent = '00';
          });
          if (ended) ended.classList.remove('hidden');
          clearInterval(interval);
          return;
        }
        var d = Math.floor(distance / 86400000);
        var h = Math.floor((distance % 86400000) / 3600000);
        var m = Math.floor((distance % 3600000) / 60000);
        var s = Math.floor((distance % 60000) / 1000);
        if (els.days) els.days.textContent = pad(d);
        if (els.hours) els.hours.textContent = pad(h);
        if (els.minutes) els.minutes.textContent = pad(m);
        if (els.seconds) els.seconds.textContent = pad(s);
      }

      update();
      interval = setInterval(update, 1000);
    });
  </script>
`;
