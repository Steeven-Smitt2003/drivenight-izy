<script>
  let {
    id,
    label,
    value = $bindable(''),
    autocomplete = 'current-password',
    minlength = undefined,
    required = true,
  } = $props();
  let visible = $state(false);
</script>

<div class="driver-password-field">
  <label for={id}>{label}</label>
  <div class="driver-password-field__control">
    <input
      {id}
      type={visible ? 'text' : 'password'}
      bind:value
      {autocomplete}
      {minlength}
      maxlength="128"
      {required}
    />
    <button
      class="password-field__toggle"
      type="button"
      aria-label={visible ? `Masquer : ${label}` : `Afficher : ${label}`}
      aria-pressed={visible}
      onclick={() => { visible = !visible; }}
    >
      {#if visible}
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
          <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 5 9.5 6-.4.6-1.6 2.3-3.5 3.8M6.2 6.2C3.9 7.7 2.7 9.7 2.5 11c.4.6 4 6 9.5 6 1 0 1.9-.2 2.7-.5" />
        </svg>
      {:else}
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      {/if}
    </button>
  </div>
</div>
