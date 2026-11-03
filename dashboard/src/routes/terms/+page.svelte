<script lang="ts">
    import type { PageProps } from './$types';
    let { data }: PageProps = $props();
</script>

<svelte:head><title>Rescova · Nutzungsbedingungen</title><meta name="robots" content="noindex" /></svelte:head>
<main>
    <a class="brand" href="/recovery">rescova<span>.</span></a>
    <p class="version">B2B · Version {data.document.version}</p>
    <h1>{data.document.title}</h1>
    <address>{data.document.provider}<br />{data.document.address}<br /><a href={`mailto:${data.document.email}`}>{data.document.email}</a></address>
    {#each data.document.sections as section}<section><h2>{section.title}</h2><p>{section.text}</p></section>{/each}
    <footer><a href="/recovery/settings#terms">Zu den Einstellungen</a><span>Rescova · Händlerbedingungen</span></footer>
</main>

<style>
    :global(body){margin:0;background:#090909;color:#f1f3f1}main{max-width:760px;margin:auto;padding:40px 24px 32px;font-family:Inter,system-ui,sans-serif;line-height:1.75}.brand{font-size:28px;letter-spacing:-1px;text-decoration:none;font-weight:600}.brand span{color:#b5e8c3}.version{font-size:12px;color:#a4aaa6;margin:36px 0 10px}h1{font-size:30px;line-height:1.2;letter-spacing:-.7px;font-weight:500;margin:0 0 24px}address{font-size:14px;font-style:normal;color:#a4aaa6;margin-bottom:36px}section{margin:28px 0}h2{font-size:17px;line-height:1.4;font-weight:500}section p{font-size:14px;color:#c4c9c6;margin:10px 0}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:2px solid #b5e8c3;outline-offset:4px}footer{border-top:1px solid #292929;padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;color:#a4aaa6;font-size:12px}@media(max-width:480px){h1{font-size:25px}main{padding:28px 20px}}@media print{:global(body){background:white;color:black}main{max-width:none;padding:0}section p,address,.version{color:black}footer{display:none}}
</style>
