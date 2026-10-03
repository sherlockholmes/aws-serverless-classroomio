<script lang="ts">
  import * as publicEnv from '$env/static/public';
  import { embedSenjaWidget } from '@cio/utils/senja';
  import { isExternalTrackingEnabled } from '$lib/utils/config/external-tracking';

  interface Props {
    id: string;
  }

  let { id = '' }: Props = $props();

  let isInitialized = $state(false);
  const externalTrackingEnabled = isExternalTrackingEnabled(publicEnv.PUBLIC_ENABLE_EXTERNAL_TRACKING);

  $effect(() => {
    const shouldEmbed = externalTrackingEnabled && !isInitialized;
    if (!shouldEmbed) {
      return;
    }

    isInitialized = true;
    embedSenjaWidget(id);
  });
</script>

{#if externalTrackingEnabled}
  <div class="senja-embed" data-id={id} data-lazyload="false" data-spinner="false"></div>
{/if}
