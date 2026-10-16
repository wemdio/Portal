const { parse } = require(process.argv[2]);
for (const h of ['waystone.com','eu.waystone.com','acme.myshopify.com','myshopify.com','wixsite.com','acme.wixsite.com','weebly.com','acme.weebly.com','github.io','co.uk','acme.co.uk','squarespace.com','business.site','acme.business.site','godaddysites.com','wordpress.com','webflow.io','127.0.0.1','xn--bcher-kva.de']) {
  const p = parse(h, { allowPrivateDomains: true }); const q = parse(h);
  console.log(h.padEnd(22), 'priv:', String(p.domain).padEnd(20), 'isPrivate', p.isPrivate, '| icann domain:', q.domain, 'isIcann', q.isIcann, 'isIp', p.isIp);
}
console.log(new URL('https://bücher.de').hostname, new URL('https://WWW.Waystone.COM./x').hostname);
