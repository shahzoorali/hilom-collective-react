<?php
/**
 * Configures Moodle's auth_oauth2 plugin to use AWS Cognito as an OIDC issuer.
 *
 * Run on the Moodle server:
 *   sudo -u www-data php moodle-configure-cognito.php \
 *        --clientid=... --clientsecret=... --poolid=... --region=... --cognitodomain=...
 *
 * This exists as a script rather than a list of admin-UI clicks because Phase 1
 * requires the working configuration to be reproducible: it is proven on the
 * disposable test box and then applied to production unchanged.
 *
 * Idempotent — re-running updates the existing issuer instead of adding a second.
 */

define('CLI_SCRIPT', true);

// Intended to be copied into <moodledir>/admin/cli/ alongside Moodle's own CLI
// scripts, which is why config.php is two levels up from here.
require(__DIR__ . '/../../config.php');
require_once($CFG->libdir . '/clilib.php');

[$options, $unrecognised] = cli_get_params([
    'help'          => false,
    'clientid'      => null,
    'clientsecret'  => null,
    'poolid'        => null,
    'region'        => 'ap-southeast-1',
    'cognitodomain' => null,
    'name'          => 'Hilom Account',
], ['h' => 'help']);

if ($options['help'] || !$options['clientid'] || !$options['clientsecret'] || !$options['poolid'] || !$options['cognitodomain']) {
    cli_writeln("Usage: php moodle-configure-cognito.php --clientid=X --clientsecret=Y --poolid=Z --cognitodomain=D [--region=ap-southeast-1]");
    exit($options['help'] ? 0 : 1);
}

$region        = $options['region'];
$poolid        = $options['poolid'];
$cognitodomain = rtrim($options['cognitodomain'], '/');

// Two different hosts are in play and mixing them up is the classic cause of a
// broken integration:
//   * the ISSUER is cognito-idp.<region>.amazonaws.com/<poolid> — this is what
//     appears in the `iss` claim and must match exactly, or token validation fails;
//   * the AUTH/TOKEN/USERINFO endpoints live on the Cognito *domain*.
$issuerurl   = "https://cognito-idp.{$region}.amazonaws.com/{$poolid}";
$authurl     = "https://{$cognitodomain}/oauth2/authorize";
$tokenurl    = "https://{$cognitodomain}/oauth2/token";
$userinfourl = "https://{$cognitodomain}/oauth2/userInfo";
$discovery   = "{$issuerurl}/.well-known/openid-configuration";

cli_heading('Configuring Cognito OAuth2 issuer');
cli_writeln("  issuer   : {$issuerurl}");
cli_writeln("  authorize: {$authurl}");
cli_writeln("  token    : {$tokenurl}");
cli_writeln("  userinfo : {$userinfourl}");
cli_writeln("  wwwroot  : {$CFG->wwwroot}");
cli_writeln("  callback : {$CFG->wwwroot}/admin/oauth2callback.php");

// ---------------------------------------------------------------------------
// Issuer
// ---------------------------------------------------------------------------
$existing = null;
foreach (\core\oauth2\api::get_all_issuers() as $candidate) {
    if ($candidate->get('name') === $options['name']) {
        $existing = $candidate;
        break;
    }
}

$fields = [
    'name'          => $options['name'],
    'image'         => 'https://d0.awsstatic.com/logos/powered-by-aws.png',
    'baseurl'       => '',
    'clientid'      => $options['clientid'],
    'clientsecret'  => $options['clientsecret'],
    'loginscopes'         => 'openid email profile',
    'loginscopesoffline'  => 'openid email profile',
    'loginparamsoffline'  => '',
    'showonloginpage'     => \core\oauth2\issuer::LOGINONLY,
    // Cognito's token endpoint authenticates the client with HTTP Basic when a
    // client secret is set. Without this Moodle posts the credentials in the
    // body and Cognito answers 401 invalid_client.
    'basicauth'     => 1,
    'enabled'       => 1,
    // Moodle's own account-confirmation email is skipped: Cognito has already
    // verified the address, and leaving it on is the usual cause of the
    // "first login appears to fail, second one works" report — the first attempt
    // silently creates an unconfirmed account and bounces the user back to the
    // login page.
    'requireconfirmation' => 0,
];

if ($existing) {
    cli_writeln("Updating existing issuer (id {$existing->get('id')})");
    foreach ($fields as $key => $value) {
        $existing->set($key, $value);
    }
    $existing->update();
    $issuer = $existing;
} else {
    cli_writeln('Creating new issuer');
    $issuer = new \core\oauth2\issuer(0, (object) $fields);
    if (!$issuer->is_valid()) {
        foreach ($issuer->get_errors() as $field => $error) {
            $msg = is_object($error) && method_exists($error, 'out') ? $error->out() : (string) $error;
            cli_writeln("  validation error on {$field}: {$msg}");
        }
        cli_error('Issuer failed validation, see above');
    }
    $issuer->create();
}

$issuerid = $issuer->get('id');

// ---------------------------------------------------------------------------
// Endpoints — replaced wholesale so a re-run cannot leave stale URLs behind.
// ---------------------------------------------------------------------------
foreach (\core\oauth2\api::get_endpoints($issuer) as $endpoint) {
    \core\oauth2\api::delete_endpoint($endpoint->get('id'));
}

$endpoints = [
    'authorization_endpoint' => $authurl,
    'token_endpoint'         => $tokenurl,
    'userinfo_endpoint'      => $userinfourl,
    'discovery_endpoint'     => $discovery,
];
foreach ($endpoints as $name => $url) {
    $endpoint = new \core\oauth2\endpoint(0, (object) [
        'issuerid' => $issuerid,
        'name'     => $name,
        'url'      => $url,
    ]);
    $endpoint->create();
    cli_writeln("  endpoint {$name} -> {$url}");
}

// ---------------------------------------------------------------------------
// Claim -> Moodle field mappings.
// Cognito's userInfo returns `email`, `given_name`, `family_name`. Without the
// email mapping Moodle cannot match or create an account and the login dies
// after a successful Cognito redirect, which looks like an SSO failure.
// ---------------------------------------------------------------------------
foreach (\core\oauth2\api::get_user_field_mappings($issuer) as $mapping) {
    \core\oauth2\api::delete_user_field_mapping($mapping->get('id'));
}

$mappings = [
    'email'       => 'email',
    'given_name'  => 'firstname',
    'family_name' => 'lastname',
];
foreach ($mappings as $external => $internal) {
    $mapping = new \core\oauth2\user_field_mapping(0, (object) [
        'issuerid'      => $issuerid,
        'externalfield' => $external,
        'internalfield' => $internal,
    ]);
    $mapping->create();
    cli_writeln("  mapping {$external} -> {$internal}");
}

// ---------------------------------------------------------------------------
// Enable the plugin. Manual auth is deliberately LEFT ENABLED: a locked project
// decision keeps native login available for admins, so that a broken Cognito
// config can never lock everyone out of Moodle.
// ---------------------------------------------------------------------------
// A fresh Moodle 4.5 install enables `email` (self-registration) by default but
// NOT `manual`, even though the CLI installer's own admin account is created
// with auth=manual. Left alone, that account would be unable to log in with a
// username/password at all — silently breaking the very fallback this locked
// decision exists to guarantee. So `manual` is force-enabled here rather than
// only warned about.
$enabled = array_filter(explode(',', (string) get_config('core', 'auth')));
$changed = false;
foreach (['oauth2', 'manual'] as $required) {
    if (!in_array($required, $enabled, true)) {
        $enabled[] = $required;
        $changed = true;
    }
}
if ($changed) {
    set_config('auth', implode(',', $enabled));
    cli_writeln('Enabled: ' . implode(', ', array_intersect(['oauth2', 'manual'], $enabled)));
}

// Users authenticate through Cognito, so Moodle must be allowed to create the
// local account on first login.
set_config('authpreventaccountcreation', 0);

purge_all_caches();

cli_writeln('');
cli_writeln('Done. Add this callback URL to the Cognito app client if not already present:');
cli_writeln("  {$CFG->wwwroot}/admin/oauth2callback.php");
