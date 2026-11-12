var fs = require('fs'),
    url = require('url'),
    path = require('path'),
    http = require('http'),
    https = require('https'),

    Resource = require('./resource.js');

// configuration
var externalUrl, // external URL of npm_lazy
    remoteUrl = 'https://registry.npmjs.com/', // "https://registry.npmjs.com/"
    remoteIsHttps = (url.parse(remoteUrl).protocol == 'https:'),
    rejectUnauthorized = true,
    logger = console;

function Package() { }

Package.configure = function(opts) {
  if (typeof opts.externalUrl !== 'undefined') {
    externalUrl = opts.externalUrl;
  }
  if (typeof opts.remoteUrl !== 'undefined') {
    remoteUrl = opts.remoteUrl;
    remoteIsHttps = (url.parse(remoteUrl).protocol == 'https:');
  }
  if (typeof opts.rejectUnauthorized !== 'undefined') {
    rejectUnauthorized = opts.rejectUnauthorized;
  }
  if (typeof opts.logger !== 'undefined') {
    logger = opts.logger;
  }
};

// uncached direct request
Package.proxy = function(req, res, message) {
  // sadly, the simple req.pipe(http.request).pipe(res) type approach
  // does not quite work, in particular the method and headers will be wrong

  var parsed = url.parse(remoteUrl),
      opts = {
        host: parsed.host,
        port: (parsed.port !== null) ? parsed.port : (remoteIsHttps ? 443 : 80),
        path: req.url,
        headers: req.headers,
        method: req.method
      };
  opts.headers.host = parsed.host;

  if (!rejectUnauthorized && parsed.protocol == 'https:') {
    opts.rejectUnauthorized = false;
    opts.agent = new https.Agent(opts);
  }

  message = message || 'not cached';
  logger.log('Querying the registry (' + message + '):', remoteUrl + req.url.substr(1));

  var outgoing = (remoteIsHttps ? https : http).request(opts, function(pres) {
    // write headers
    Object.keys(pres.headers).forEach(function(key) {
      res.setHeader(key, pres.headers[key]);
    });
    // write statuscode
    res.writeHead(pres.statusCode);
    // write response
    pres.pipe(res);
  });

  req.pipe(outgoing).once('error', function(e) {
    logger.log('Ignoring query error (not cached):', e);
    res.statusCode = 500;
    res.end('{}');
  });

  // logger.log(req.headers);
  // req.pipe(process.stdout);
};

Package.getIndex = function(pname, auth, onDone) {
  // package index
  var uri = remoteUrl + pname,
      r = Resource.get(uri, auth);

  r.on('fetch-error', function(err, current, max) {
    logger.log('Fetch failed (' + current + '/' + max + '): ' + uri, err);
  });

  r.on('fetch-cached', function() {
    logger.log('[OK] Reusing cached result for ' + uri);
  });

  r.getReadablePath(function(err, data, etag) {
    if (err) {
      return onDone(err);
    }

    r.removeAllListeners('fetch-error');
    r.removeAllListeners('fetch-cached');

    var doc;
    try {
      doc = JSON.parse(fs.readFileSync(data));
    } catch (e) {
      e.statusCode = 500;
      return onDone(e);
    }
    return onDone(err, Package._rewriteLocation(doc), etag);
  });
};

Package.getVersion = function(pname, version, onDone) {
  // package index
  var uri = remoteUrl + pname,
      r = Resource.get(uri);

  r.on('fetch-error', function() {
    logger.log('Fetch failed: ' + uri);
  });

  r.on('fetch-cached', function() {
    logger.log('[OK] Reusing cached result for ' + uri);
  });


  r.getReadablePath(function(err, fullpath, etag) {
    if (err) {
      return onDone(err);
    }

    r.removeAllListeners('fetch-error');
    r.removeAllListeners('fetch-cached');

    // according to the NPM source, the version specific JSON is
    // directly from the index document (e.g. just take doc.versions[ver])
    var doc;
    try {
      doc = JSON.parse(fs.readFileSync(fullpath));
    } catch (e) {
      e.statusCode = 500;
      return onDone(e);
    }

    // unpublished/placeholder documents have no versions or dist-tags
    var versions = (doc && typeof doc.versions === 'object' && doc.versions) || {},
        tags = (doc && typeof doc['dist-tags'] === 'object' && doc['dist-tags']) || {};

    // from NPM: if not a valid version, then treat as a tag.
    if (!Object.prototype.hasOwnProperty.call(versions, version) &&
        Object.prototype.hasOwnProperty.call(tags, version)) {
      version = tags[version];
    }
    if (Object.prototype.hasOwnProperty.call(versions, version) && versions[version]) {
      return onDone(undefined, Package._rewriteLocation(versions[version]), etag);
    }
    var notFound = new Error('Could not find version ' + version + ' of ' + pname);
    notFound.statusCode = 404;
    notFound.content = JSON.stringify({ error: 'version not found: ' + version });
    return onDone(notFound);
  });
};

Package._rewriteLocation = function(meta) {
  if (!meta) {
    return meta;
  }

  if (meta.versions) {
    // if a full index, apply to all versions
    Object.keys(meta.versions).forEach(function(version) {
      meta.versions[version] = Package._rewriteLocation(meta.versions[version]);
    });
  }

  if (meta.dist && meta.dist.tarball) {
    var parts = url.parse(meta.dist.tarball);
    meta.dist.tarball = externalUrl + parts.pathname;
  }
  return meta;
};

module.exports = Package;
