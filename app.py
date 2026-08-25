from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    session,
)
import requests
from bs4 import BeautifulSoup
import re
import secrets
import urllib.parse
import ipaddress
import os
import hashlib
import logging
import xml.etree.ElementTree as ET
from datetime import timedelta

from view_counter import get_db_path, increment, get_count
from button_stats import record_click, get_button_stats

app = Flask(__name__)

CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "frame-src 'none'",
])


@app.after_request
def apply_security_headers(response):
    """Apply baseline browser security headers for all responses."""
    response.headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = (
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), '
        'microphone=(), payment=(), usb=()'
    )
    if request.is_secure:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    return response


def _get_secret_key():
    """Resolve secret key: env, then instance/secret.key, otherwise generate."""
    key = os.environ.get('FLASK_SECRET_KEY') or os.environ.get('SECRET_KEY')
    if key:
        return key
    instance_path = app.instance_path
    secret_file = os.path.join(instance_path, 'secret.key')
    try:
        os.makedirs(instance_path, exist_ok=True)
    except OSError:
        pass
    if os.path.isfile(secret_file):
        try:
            with open(secret_file, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except (OSError, IOError):
            pass
    key = secrets.token_hex(32)
    try:
        with open(secret_file, 'w', encoding='utf-8') as f:
            f.write(key)
    except OSError:
        pass
    return key


app.secret_key = _get_secret_key()
is_production = os.environ.get('URGE_ENV', '').lower() == 'production'

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=is_production,
    PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
)


@app.before_request
def set_session_lifetime():
    # Keep session data short-lived for privacy-by-default.
    session.permanent = True


def _mask_client_ip(ip_value):
    """Return a privacy-preserving representation of client IP."""
    ip_raw = (ip_value or '').split(',')[0].strip()
    if not ip_raw:
        return 'unknown'
    try:
        ip_obj = ipaddress.ip_address(ip_raw)
        if ip_obj.version == 4:
            parts = ip_raw.split('.')
            return f'{parts[0]}.{parts[1]}.x.x'
        return ':'.join(ip_raw.split(':')[:3]) + ':x:x'
    except ValueError:
        return 'masked'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

DEFAULT_DATAVERSE_BASE_URL = 'https://dataverse.no'
_DEFAULT_DATAVERSE_ALLOWED_HOSTS = frozenset({'dataverse.no', 'demo.dataverse.no'})
_DATAVERSE_HOST_TOKEN = re.compile(
    r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)'
    r'(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$'
)

# Figshare API (read-only import); host allow-list for outbound requests
FIGSHARE_API_HOST = 'api.figshare.com'
FIGSHARE_API_BASE = f'https://{FIGSHARE_API_HOST}'

# Zenodo Deposit API; strict host allow-list for outbound requests
ZENODO_ALLOWED_HOSTS = frozenset({
    'zenodo.org',
    'www.zenodo.org',
    'sandbox.zenodo.org',
})
DEFAULT_ZENODO_API_BASE_URL = 'https://zenodo.org'


class DataverseHostNotAllowed(ValueError):
    """Raised when the Dataverse hostname is not on the operator allow-list."""


def _parse_dataverse_allowed_hosts():
    """Return the Dataverse hostname allow-list. Fail closed to the built-in list."""
    raw = os.environ.get('URGE_DATAVERSE_ALLOWED_HOSTS')
    if raw is None or not str(raw).strip():
        return _DEFAULT_DATAVERSE_ALLOWED_HOSTS

    tokens = [part.strip().lower().rstrip('.') for part in str(raw).split(',')]
    tokens = [part for part in tokens if part]
    if not tokens:
        return _DEFAULT_DATAVERSE_ALLOWED_HOSTS

    extras = []
    for token in tokens:
        if '/' in token or '@' in token or ':' in token or ' ' in token:
            return _DEFAULT_DATAVERSE_ALLOWED_HOSTS
        if not _DATAVERSE_HOST_TOKEN.match(token):
            return _DEFAULT_DATAVERSE_ALLOWED_HOSTS
        extras.append(token)

    return frozenset(_DEFAULT_DATAVERSE_ALLOWED_HOSTS | set(extras))


def _dataverse_host_permitted(host):
    """True if host is listed or is a subdomain of a listed host."""
    allowed = _parse_dataverse_allowed_hosts()
    if host in allowed:
        return True
    return any(host.endswith('.' + allowed_host) for allowed_host in allowed)


def _is_public_host(hostname):
    host = (hostname or '').strip().lower().rstrip('.')
    if not host or host == 'localhost' or host.endswith('.localhost'):
        return False

    try:
        ip = ipaddress.ip_address(host)
        return not (
            ip.is_private or
            ip.is_loopback or
            ip.is_link_local or
            ip.is_multicast or
            ip.is_reserved or
            ip.is_unspecified
        )
    except ValueError:
        return True


def normalize_dataverse_base_url(raw_url=None):
    candidate = (raw_url or DEFAULT_DATAVERSE_BASE_URL).strip()
    if not candidate:
        candidate = DEFAULT_DATAVERSE_BASE_URL

    if not re.match(r'^https?://', candidate, re.IGNORECASE):
        candidate = f'https://{candidate}'

    parsed = urllib.parse.urlparse(candidate)
    host = (parsed.hostname or '').lower().split(':')[0]

    if parsed.scheme != 'https':
        raise ValueError('Dataverse address must use HTTPS')
    if parsed.username or parsed.password:
        raise ValueError('Dataverse address cannot include username or password')
    if not _is_public_host(host):
        raise ValueError('Dataverse address is not allowed')

    clean_path = (parsed.path or '').rstrip('/')
    if not _dataverse_host_permitted(host):
        raise DataverseHostNotAllowed(
            'This Dataverse instance is not on the supported list.'
        )
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, clean_path, '', '', ''))


def build_dataverse_url(base_url, path, query=''):
    parsed = urllib.parse.urlparse(normalize_dataverse_base_url(base_url))
    base_path = (parsed.path or '').rstrip('/')
    suffix = '/' + path.lstrip('/')
    full_path = f'{base_path}{suffix}' if base_path else suffix
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, full_path, '', query, ''))


def _dataverse_get(url, **kwargs):
    """GET a Dataverse URL. Verify TLS first; retry once if the instance cert chain is broken.

    Self-hosted Dataverse often uses an institutional or incomplete certificate.
    Figshare/Zenodo are not given this fallback.
    """
    kwargs.pop('verify', None)
    kwargs.setdefault('timeout', 30)
    try:
        return requests.get(url, verify=True, **kwargs)
    except requests.exceptions.SSLError as err:
        logger.warning(
            'Dataverse TLS verification failed, retrying without certificate check: %s',
            err,
        )
        return requests.get(url, **kwargs)


def preview_url_matches_base(preview_url, base_url):
    preview = urllib.parse.urlparse(preview_url)
    base = urllib.parse.urlparse(normalize_dataverse_base_url(base_url))

    if preview.scheme != base.scheme or preview.netloc.lower() != base.netloc.lower():
        return False

    base_path = (base.path or '').rstrip('/')
    preview_path = preview.path or ''
    if base_path and not (preview_path == base_path or preview_path.startswith(base_path + '/')):
        return False

    return True


def normalize_zenodo_api_base_url(raw_url=None):
    """Normalize Zenodo site base URL (HTTPS only, allow-listed host, no userinfo)."""
    candidate = (raw_url or DEFAULT_ZENODO_API_BASE_URL).strip()
    if not candidate:
        candidate = DEFAULT_ZENODO_API_BASE_URL

    if not re.match(r'^https?://', candidate, re.IGNORECASE):
        candidate = f'https://{candidate}'

    parsed = urllib.parse.urlparse(candidate)
    host = (parsed.hostname or '').lower().split(':')[0]

    if parsed.scheme != 'https':
        raise ValueError('Zenodo address must use HTTPS')
    if parsed.username or parsed.password:
        raise ValueError('Zenodo address cannot include username or password')
    if host not in ZENODO_ALLOWED_HOSTS:
        raise ValueError('Zenodo address host is not allowed')
    if not _is_public_host(host):
        raise ValueError('Zenodo address is not allowed')

    path = (parsed.path or '').strip().rstrip('/')
    if path:
        raise ValueError('Zenodo base URL must not include a path (use e.g. https://zenodo.org)')

    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))


def build_zenodo_deposit_url(base_url, path, query=None):
    """Build an absolute URL under /api/deposit/... for an allow-listed Zenodo base."""
    base = normalize_zenodo_api_base_url(base_url).rstrip('/')
    rel = path.lstrip('/')
    if not rel.startswith('api/deposit/'):
        raise ValueError('Invalid Zenodo API path')
    url = f'{base}/{rel}'
    if query:
        q = urllib.parse.urlencode(query, doseq=True)
        url = f'{url}?{q}'
    return url


def _zenodo_request_headers(access_token):
    """Build Zenodo REST headers. Never log the raw token."""
    token = ''.join((access_token or '').strip().split())
    return {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) URGE-ZenodoImport/1.0',
    }


@app.route('/')
def home():
    # Only this route is counted (dataverse.html); no personal data stored
    path = get_db_path(app)
    increment(path)
    return render_template(
        'dataverse.html',
        dataverse_allowed_hosts=sorted(_parse_dataverse_allowed_hosts()),
    )


@app.route('/updates')
def updates():
    # Not counted; only display current total
    path = get_db_path(app)
    view_count = get_count(path)
    button_stats = get_button_stats(app)
    return render_template('updates.html', view_count=view_count, button_stats=button_stats)


@app.route('/privacy')
def privacy_policy():
    return render_template('privacy.html')


@app.route('/api/record_button_click', methods=['POST'])
def api_record_button_click():
    """Record a daily aggregated button click. No personal data is stored."""
    try:
        data = request.get_json() or {}
        button_id = (data.get('button_id') or '').strip()
        if not button_id:
            return jsonify({'ok': False, 'error': 'button_id required'}), 400
        record_click(app, button_id)
        return jsonify({'ok': True})
    except Exception:
        return jsonify({'ok': False}), 500


@app.route('/fetch_dataset_preview', methods=['POST'])
def fetch_dataset_preview():
    try:
        data = request.get_json() or {}
        url = (data.get('preview_url') or '').strip()
        dataverse_base_url_raw = data.get('dataverse_base_url')
        if data.get('encoded'):
            import base64
            url = base64.b64decode(url).decode('utf-8')
            if dataverse_base_url_raw:
                dataverse_base_url_raw = base64.b64decode(dataverse_base_url_raw).decode('utf-8')

        if not url:
            return jsonify({'error': 'URL required'}), 400

        try:
            dataverse_base_url = normalize_dataverse_base_url(dataverse_base_url_raw)
        except ValueError as err:
            return jsonify({'error': str(err)}), 400

        parsed = urllib.parse.urlparse(url)
        preview_host = (parsed.hostname or '').lower().split(':')[0]
        if parsed.scheme != 'https' or not _is_public_host(preview_host):
            return jsonify({'error': 'URL not allowed'}), 400
        if 'previewurl.xhtml' not in (parsed.path or ''):
            return jsonify({'error': 'Invalid Dataverse preview URL'}), 400
        if not preview_url_matches_base(url, dataverse_base_url):
            return jsonify({'error': 'Preview URL must belong to the selected Dataverse address'}), 400

        response = _dataverse_get(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout=30
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        metadata = {}

        title_elem = soup.find('h1')
        if title_elem:
            metadata['title'] = title_elem.text.strip()

        doi_elem = soup.find('meta', {'name': 'DC.identifier'})
        if doi_elem:
            metadata['doi'] = doi_elem.get('content', '').replace('doi:', '')

        description_elem = soup.find('div', {'class': 'description'})
        if description_elem:
            metadata['description'] = description_elem.text.strip()
        else:
            description_elem = soup.find(string=re.compile('Description', re.IGNORECASE))
            if description_elem:
                parent = description_elem.parent
                if parent:
                    value_elem = parent.find_next_sibling()
                    if value_elem:
                        metadata['description'] = value_elem.get_text(strip=True)

        author_elem = soup.find('meta', {'name': 'metadata_datasetContact'})
        if author_elem:
            content = author_elem.get('content', '').strip()
            content = content.replace("Use email button above to contact.", "").strip()
            match = re.search(r'([A-Za-zÇçĞğİıÖöŞşÜüÆæØøÅå]+,\s[A-Za-zÇçĞğİıÖöŞşÜüÆæØøÅå]+)', content)
            if match:
                metadata['author'] = match.group(1)
            else:
                metadata['author'] = 'Unknown Author'
        else:
            author_elem = soup.find(string=re.compile('Point of Contact|metadata_datasetContact', re.IGNORECASE))
            if author_elem:
                parent = author_elem.parent
                if parent:
                    value_elem = parent.find_next_sibling()
                    if value_elem:
                        text = value_elem.get_text(strip=True)
                        text = text.replace("Use email button above to contact.", "").strip()
                        match = re.search(r'([A-Za-zÇçĞğİıÖöŞşÜüÆæØøÅå]+,\s[A-Za-zÇçĞğİıÖöŞşÜüÆæØøÅå]+)', text)
                        if match:
                            metadata['author'] = match.group(1)
                        else:
                            metadata['author'] = 'Unknown Author'

        files = []
        file_table = soup.find('div', {'id': 'datasetForm:tabView:filesTable'})
        if file_table:
            file_rows = file_table.find_all('tr', {'class': lambda x: x and 'ui-widget-content' in x})
            for row in file_rows:
                try:
                    file_info_div = row.find('div', {'class': 'media-body'})
                    if file_info_div:
                        file_info = {}

                        name_div = file_info_div.find('div', {'class': 'fileNameOriginal'})
                        if name_div and name_div.find('a'):
                            file_info['name'] = name_div.find('a').text.strip()

                        details_div = file_info_div.find('div', {'class': 'text-muted'})
                        if details_div:
                            type_span = details_div.find('span', {'id': re.compile(r'.*fileType$')})
                            if type_span:
                                file_info['type'] = type_span.text.strip()

                            size_span = details_div.find('span', {'id': re.compile(r'.*fileSize$')})
                            if size_span:
                                file_info['size'] = size_span.text.strip().lstrip('- ')

                            date_span = details_div.find('span', {'id': re.compile(r'.*fileCreatePublishDate$')})
                            if date_span:
                                file_info['deposit_date'] = date_span.text.replace('Deposited', '').strip()

                        if file_info:
                            files.append(file_info)
                except Exception as e:
                    logger.warning("Could not parse file metadata from preview: %s", e)
                    continue

        metadata['files'] = files

        field_mappings = {
            'contributors': {
                'terms': ['Contributor', 'Contributors', 'Author', 'Authors', 'Creator'],
                'class': 'contributor'
            },
            'dataType': {
                'terms': ['Data Type', 'Type of Data', 'Kind of Data'],
                'class': 'kindOfData'
            },
            'dateCollection': {
                'terms': ['Date of Collection', 'Collection Date', 'Time Period'],
                'class': 'dateOfCollection'
            },
            'geoLocation': {
                'terms': ['Geographic Coverage', 'Location', 'Production Place'],
                'class': 'geographicCoverage'
            },
            'funding': {
                'terms': ['Funding Information', 'Financial Support'],
                'class': 'grantNumber'
            },
            'license': {
                'terms': ['License', 'Terms of Use', 'Usage Rights'],
                'class': 'license'
            },
            'relatedPublication': {
                'id': 'metadata_publication'
            },
            'relatedDataset': {
                'terms': ['Related Dataset', 'Related Data', 'Associated Data'],
                'class': 'relatedDataset'
            },
            'dataSources': {
                'terms': ['Data Source', 'Source Data', 'Original Data'],
                'class': 'dataSources'
            }
        }

        for field, mapping in field_mappings.items():
            result = None
            if 'id' in mapping:
                element = soup.find(id=mapping['id'])
                if element:
                    tds = element.find_all('td')
                    if len(tds) > 1:
                        result = tds[1].get_text(separator="\n", strip=True)
                    else:
                        result = element.get_text(strip=True)
                        result = result.replace('Related Publication', '').strip()

            else:
                values = []
                elements = soup.find_all(class_=mapping.get('class'))
                if elements:
                    for element in elements:
                        value = element.get_text(strip=True)
                        if value:
                            values.append(value)
                    if values:
                        result = ', '.join(values)

                if not result:
                    for term in mapping.get('terms', []):
                        elements = soup.find_all(string=re.compile(term, re.IGNORECASE))
                        for element in elements:
                            parent = element.parent
                            if parent:
                                value_element = parent.find_next_sibling() or parent.parent.find_next_sibling()
                                if value_element:
                                    result = value_element.get_text(strip=True)
                                    break
                            if result:
                                break

            metadata[field] = result or ''

        session['metadata'] = metadata

        return jsonify(metadata)

    except Exception as e:
        logger.exception("Unexpected error while fetching dataset preview")
        return jsonify({'error': str(e)}), 500

@app.route('/fetch_dataverse_metadata', methods=['POST'])
def fetch_dataverse_metadata():
    try:
        data = request.get_json()
        field = data.get('field')
        
        if not field:
            return jsonify({'error': 'Field type required'}), 400
            
        metadata = session.get('metadata', {})
        result = metadata.get(field)
        
        if result:
            return jsonify({'data': result})
        else:
            return jsonify({'error': 'Data not found'}), 404
            
    except Exception as e:
        logger.exception("Unexpected error while fetching metadata from session")
        return jsonify({'error': str(e)}), 500


@app.route('/api/clear_session_metadata', methods=['POST'])
def api_clear_session_metadata():
    """Clear cached API metadata from the session after README/JSON download."""
    try:
        session.pop('metadata', None)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/get_citation', methods=['POST'])
def get_citation():
    try:
        data = request.get_json()
        doi = data.get('doi')
        format_type = data.get('format')
        
        if not doi or not format_type:
            return jsonify({'error': 'DOI and format type required'}), 400
            
        format_endpoints = {
            'endnotexml': 'endnote',
            'ris': 'ris',
            'bibtex': 'bibtex'
        }
        
        if format_type not in format_endpoints:
            return jsonify({'error': 'Invalid format type'}), 400
            
        api_url = f'https://api.datacite.org/dois/{doi}'
        headers = {
            'Accept': f'application/{format_endpoints[format_type]}'
        }
        
        response = requests.get(api_url, headers=headers)
        response.raise_for_status()
        
        return jsonify({'citation': response.text})
        
    except requests.RequestException as e:
        return jsonify({'error': f'Could not retrieve citation: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/orcid_search')
def api_orcid_search():
    """Search ORCID by given/family name and return JSON results."""
    try:
        given = (request.args.get('given') or '').strip()
        family = (request.args.get('family') or '').strip()
        q_raw = (request.args.get('q') or '').strip()

        if given or family:
            terms = []
            if given:
                terms.append(f'given-names:{given}')
            if family:
                terms.append(f'family-name:{family}')
            query = ' AND '.join(terms)
        elif q_raw:
            query = q_raw
        else:
            return jsonify({'results': []})

        url_expanded = 'https://pub.orcid.org/v3.0/expanded-search/'
        params = {'q': query}
        headers = {'Accept': 'application/xml'}

        response = requests.get(url_expanded, params=params, headers=headers, timeout=10)
        response.raise_for_status()

        # ORCID sometimes returns an XML error payload.
        if b'<error ' in response.content or b'response-code' in response.content:
            url_search = 'https://pub.orcid.org/v3.0/search/'
            response = requests.get(url_search, params=params, headers=headers, timeout=10)
            response.raise_for_status()
            ns = {'srch': 'http://www.orcid.org/ns/search', 'common': 'http://www.orcid.org/ns/common'}
            root = ET.fromstring(response.text)
            results = []
            for result in root.findall('srch:result', ns):
                oid = result.find('.//common:orcid-identifier', ns)
                if oid is None:
                    continue
                path_el = oid.find('common:path', ns)
                if path_el is None or not (path_el.text or '').strip():
                    continue
                orcid_id = path_el.text.strip()
                results.append({
                    'orcid': orcid_id,
                    'given_names': '',
                    'family_names': '',
                    'name': orcid_id,
                    'institution': '',
                })
                if len(results) >= 20:
                    break
        else:
            ns = {'es': 'http://www.orcid.org/ns/expanded-search'}
            root = ET.fromstring(response.text)
            results = []
            for result in root.findall('es:expanded-result', ns):
                orcid_el = result.find('es:orcid-id', ns)
                if orcid_el is None or not (orcid_el.text or '').strip():
                    continue
                orcid_id = (orcid_el.text or '').strip()
                given_el = result.find('es:given-names', ns)
                family_el = result.find('es:family-names', ns)
                given_names = (given_el.text or '').strip() if given_el is not None and (given_el.text or '').strip() else ''
                family_names = (family_el.text or '').strip() if family_el is not None and (family_el.text or '').strip() else ''
                name_parts = [p for p in [family_names, given_names] if p]
                display_name = ', '.join(name_parts) if name_parts else orcid_id
                institution = ''
                first_inst = result.find('es:institution-name', ns)
                if first_inst is not None and first_inst.text:
                    institution = first_inst.text.strip()
                else:
                    for inst in result.findall('es:institution-name', ns):
                        if inst.text and inst.text.strip():
                            institution = inst.text.strip()
                            break
                results.append({
                    'orcid': orcid_id,
                    'given_names': given_names,
                    'family_names': family_names,
                    'name': display_name,
                    'institution': institution,
                })
                if len(results) >= 20:
                    break

        return jsonify({'results': results})
    except requests.RequestException as e:
        logger.warning('ORCID search request failed: %s', e)
        return jsonify({'results': [], 'error': 'ORCID request to ORCID.org failed'}), 502
    except Exception as e:
        logger.exception('Unexpected error in api_orcid_search')
        return jsonify({'results': [], 'error': str(e)}), 500


@app.route('/fetch_dataset_api', methods=['POST'])
def fetch_dataset_api():
    logger.info("fetch_dataset_api request started (%s)", request.method)

    try:
        data = request.get_json(silent=True) or {}
        api_token = (data.get('api_token') or '').strip()
        doi_url = (data.get('doi') or '').strip()
        dataverse_base_url_raw = data.get('dataverse_base_url')
        api_token = ''.join(api_token.split())

        if not api_token or not doi_url:
            return jsonify({'error': 'API token and DOI address are required'}), 400

        try:
            dataverse_base_url = normalize_dataverse_base_url(dataverse_base_url_raw)
        except ValueError as err:
            return jsonify({'error': str(err)}), 400

        # Avoid logging full client IP addresses for GDPR data minimization.
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', ''))
        masked_ip = _mask_client_ip(client_ip)
        logger.info("Dataset API request received (client=%s)", masked_ip)
        
        if doi_url.startswith('http'):
            persistent_id = doi_url.split('doi.org/')[-1]
        else:
            persistent_id = doi_url

        # Try /api/v1 first (matches the frontend), then /api/.
        persistent_id_query = urllib.parse.urlencode({'persistentId': f'doi:{persistent_id}'})
        api_urls = [
            build_dataverse_url(dataverse_base_url, '/api/v1/datasets/:persistentId', persistent_id_query),
            build_dataverse_url(dataverse_base_url, '/api/datasets/:persistentId/', persistent_id_query)
        ]
        
        # Some hosts reject requests without a browser-like User-Agent.
        headers = {
            'X-Dataverse-key': api_token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
        response = None
        last_error = None
        last_status_code = None
        successful_api_url = None
        
        for api_url in api_urls:
            try:
                response = _dataverse_get(api_url, headers=headers, timeout=30)
                last_status_code = response.status_code
                successful_api_url = api_url
                logger.info("API request sent: %s, Status: %s", api_url, response.status_code)
                if response.status_code == 200:
                    break
            except requests.exceptions.RequestException as req_err:
                last_error = req_err
                logger.error("API request error: %s", req_err)
                continue
        
        if response is None:
            error_msg = f'API request failed: {str(last_error)}' if last_error else 'API request failed'
            logger.error("All API URLs failed. Last error: %s", error_msg)
            return jsonify({
                'error': error_msg,
                'debug_info': {
                    'persistent_id': persistent_id,
                    'api_urls_tried': api_urls,
                    'last_error': str(last_error) if last_error else None
                }
            }), 500
        
        if response.status_code == 403:
            error_detail = 'API token invalid or you do not have access to this dataset'
            response_headers = dict(response.headers)
            response_text = response.text[:500] if response.text else ''
            
            logger.error("403 Forbidden received:")
            logger.error(f"  API URL: {successful_api_url if successful_api_url else 'N/A'}")
            logger.error(f"  Response Headers: {response_headers}")
            logger.error(f"  Response Text: {response_text}")
            # Never log the API token.
            logger.error(f"  API Token: [REDACTED]")
            logger.error(f"  Persistent ID: {persistent_id}")
            logger.error(f"  Client IP: {masked_ip}")
            
            try:
                error_json = response.json()
                if 'message' in error_json:
                    error_detail = error_json['message']
                logger.error(f"  Error JSON: {error_json}")
            except:
                error_detail = response_text if response_text else error_detail
            
            return jsonify({
                'error': 'Access denied (403 Forbidden)',
                'detail': error_detail,
                'status_code': 403,
                'debug_info': {
                    'response_headers': response_headers,
                    'response_text_preview': response_text,
                    'persistent_id': persistent_id,
                    'api_url_used': successful_api_url if successful_api_url else None
                }
            }), 403
        elif response.status_code == 404:
            return jsonify({
                'error': 'Dataset not found (404 Not Found)',
                'detail': f'Dataset not found with DOI: {persistent_id}',
                'status_code': 404
            }), 404
        elif response.status_code == 401:
            return jsonify({
                'error': 'Authentication error (401 Unauthorized)',
                'detail': 'API token invalid or missing',
                'status_code': 401
            }), 401
        elif response.status_code != 200:
            error_detail = response.text[:500] if response.text else 'Unknown error'
            try:
                error_json = response.json()
                if 'message' in error_json:
                    error_detail = error_json['message']
            except:
                pass
            return jsonify({
                'error': f'Could not retrieve data from API (HTTP {response.status_code})',
                'detail': error_detail,
                'status_code': response.status_code
            }), response.status_code

        dataset_json = response.json()
        metadata = {'doi': dataset_json['data'].get('persistentUrl', '')}
        citation_block = dataset_json['data']['latestVersion']['metadataBlocks']['citation']['fields']
        for field in citation_block:
            try:
                if field['typeName'] == 'title':
                    metadata['title'] = field.get('value', '')
                if field['typeName'] == 'author':
                    authors = []
                    for author in field.get('value', []):
                        if isinstance(author, dict) and 'authorName' in author:
                            authors.append(author['authorName'].get('value', str(author['authorName'])))
                        if isinstance(author, dict) and 'authorAffiliation' in author:
                            metadata['institution'] = author['authorAffiliation'].get('value', str(author['authorAffiliation']))
                        if isinstance(author, dict) and 'authorIdentifierScheme' in author and 'authorIdentifier' in author:
                            scheme = author['authorIdentifierScheme'].get('value', str(author['authorIdentifierScheme'])).strip().upper()
                            if scheme == 'ORCID':
                                metadata['orcid'] = author['authorIdentifier'].get('value', str(author['authorIdentifier'])).strip()
                    metadata['author'] = ', '.join(authors)
                if field['typeName'] == 'dsDescription':
                    desc = field.get('value', [{}])
                    if isinstance(desc, list) and desc and isinstance(desc[0], dict):
                        metadata['description'] = desc[0].get('dsDescriptionValue', {}).get('value', '')
                    else:
                        metadata['description'] = str(desc)
                if field['typeName'] == 'datasetContact':
                    for contact in field.get('value', []):
                        if isinstance(contact, dict):
                            if 'datasetContactEmail' in contact:
                                metadata['email'] = contact['datasetContactEmail'].get('value', str(contact['datasetContactEmail']))
                            if 'datasetContactName' in contact:
                                metadata['contact_name'] = contact['datasetContactName'].get('value', str(contact['datasetContactName']))
                            if 'datasetContactAffiliation' in contact:
                                metadata['institution'] = contact['datasetContactAffiliation'].get('value', str(contact['datasetContactAffiliation']))
                            if 'datasetContactIdentifier' in contact and not metadata.get('orcid'):
                                metadata['orcid'] = contact['datasetContactIdentifier'].get('value', str(contact['datasetContactIdentifier'])).strip()
                if field['typeName'] == 'contributor':
                    contributors = []
                    for c in field.get('value', []):
                        if isinstance(c, dict) and 'contributorName' in c:
                            contributors.append(c['contributorName'].get('value', str(c['contributorName'])))
                    metadata['contributors'] = ', '.join(contributors)
                if field['typeName'] == 'kindOfData':
                    val = field.get('value', '')
                    if isinstance(val, list):
                        metadata['dataType'] = ', '.join([str(v) for v in val])
                    else:
                        metadata['dataType'] = str(val)
                if field['typeName'] == 'dateOfCollection':
                    val = field.get('value', '')
                    if isinstance(val, list) and val and isinstance(val[0], dict) and 'dateOfCollectionStart' in val[0]:
                        date_ranges = []
                        for v in val:
                            start = v.get('dateOfCollectionStart', {}).get('value', '')
                            end = v.get('dateOfCollectionEnd', {}).get('value', '')
                            if start and end:
                                date_ranges.append(f"{start} - {end}")
                            elif start:
                                date_ranges.append(start)
                            elif end:
                                date_ranges.append(end)
                        metadata['dateCollection'] = ', '.join(date_ranges)
                    elif isinstance(val, list):
                        metadata['dateCollection'] = ', '.join([str(v) if not isinstance(v, dict) else v.get('date', str(v)) for v in val])
                    elif isinstance(val, dict):
                        metadata['dateCollection'] = val.get('date', str(val))
                    else:
                        metadata['dateCollection'] = str(val)
                if field['typeName'] == 'geographicCoverage':
                    val = field.get('value', '')
                    if isinstance(val, list):
                        metadata['geoLocation'] = ', '.join([str(v) if not isinstance(v, dict) else v.get('country', str(v)) for v in val])
                    elif isinstance(val, dict):
                        metadata['geoLocation'] = val.get('country', str(val))
                    else:
                        metadata['geoLocation'] = str(val)
                if field['typeName'] == 'grantNumber':
                    grants = []
                    for g in field.get('value', []):
                        if isinstance(g, dict) and 'grantNumberAgency' in g:
                            agency_val = g['grantNumberAgency'].get('value', str(g['grantNumberAgency']))
                            if isinstance(agency_val, str) and agency_val.startswith('https://ror.org/'):
                                try:
                                    ror_id = agency_val.split('https://ror.org/')[-1]
                                    ror_api_url = f'https://api.ror.org/v1/organizations/{ror_id}'
                                    ror_resp = requests.get(ror_api_url, timeout=5)
                                    if ror_resp.status_code == 200:
                                        ror_data = ror_resp.json()
                                        agency_val = ror_data.get('name', agency_val)
                                except Exception as ror_err:
                                    logger.warning('ROR API lookup failed: %s', ror_err)
                            grants.append(agency_val)
                    metadata['funding'] = ', '.join(grants)
                if field['typeName'] == 'license':
                    lic_val = field.get('value', '')
                    if isinstance(lic_val, dict):
                        name = lic_val.get('name', '')
                        uri = lic_val.get('uri', '')
                        if name and uri:
                            metadata['license'] = f"{name} ({uri})"
                        elif name:
                            metadata['license'] = name
                        elif uri:
                            metadata['license'] = uri
                        else:
                            metadata['license'] = str(lic_val)
                    else:
                        metadata['license'] = str(lic_val)
                if field['typeName'] == 'subject':
                    val = field.get('value', '')
                    if isinstance(val, list):
                        metadata['keyword'] = ', '.join([str(v) for v in val])
                    else:
                        metadata['keyword'] = str(val)
                if field['typeName'] == 'publication':
                    pubs = field.get('value', [])
                    if isinstance(pubs, list):
                        pub_citations = []
                        pub_parts = []
                        for pub in pubs:
                            if isinstance(pub, dict):
                                citation = pub.get('publicationCitation', {}).get('value', '')
                                if citation:
                                    pub_citations.append(citation)
                                id_type = pub.get('publicationIdType', {}).get('value', '') if isinstance(pub.get('publicationIdType'), dict) else ''
                                id_num = pub.get('publicationIdNumber', {}).get('value', '') if isinstance(pub.get('publicationIdNumber'), dict) else ''
                                url = pub.get('publicationURL', {}).get('value', '') if isinstance(pub.get('publicationURL'), dict) else ''
                                if id_type or id_num or url:
                                    pub_parts.append('; '.join(filter(None, [id_type, id_num, url])))
                        metadata['relatedPublication'] = '; '.join(pub_citations)
                        if pub_parts:
                            metadata['relatedPublicationIds'] = ' | '.join(pub_parts)
                if field['typeName'] == 'relatedDatasets':
                    datasets = field.get('value', [])
                    if isinstance(datasets, list):
                        dataset_list = []
                        for d in datasets:
                            if isinstance(d, dict):
                                dataset_list.append(d.get('relatedDataset', str(d)))
                            elif isinstance(d, str):
                                dataset_list.append(d)
                        metadata['relatedDataset'] = '; '.join(dataset_list)
                    else:
                        metadata['relatedDataset'] = str(datasets)
                if field['typeName'] == 'dataSources':
                    sources = field.get('value', [])
                    if isinstance(sources, list):
                        metadata['dataSources'] = '; '.join([str(s) for s in sources])
                    else:
                        metadata['dataSources'] = str(sources)
                if field['typeName'] == 'productionPlace':
                    places = field.get('value', [])
                    if isinstance(places, list):
                        geo_val = ', '.join([str(p) for p in places])
                        if metadata.get('geoLocation'):
                            metadata['geoLocation'] += ', ' + geo_val
                        else:
                            metadata['geoLocation'] = geo_val
            except Exception as err:
                logger.warning(
                    "Metadata parse issue (%s): %s",
                    field.get('typeName', 'unknown'),
                    err,
                )
        if not metadata.get('doi'):
            metadata['doi'] = dataset_json['data'].get('persistentUrl', '')
        if not metadata.get('relatedPublication'):
            pubs = dataset_json['data']['latestVersion'].get('relatedPublications', [])
            if isinstance(pubs, list):
                metadata['relatedPublication'] = '; '.join([p.get('publicationCitation', str(p)) for p in pubs if isinstance(p, dict)])
            else:
                metadata['relatedPublication'] = str(pubs)
        if not metadata.get('relatedDataset'):
            datasets = dataset_json['data']['latestVersion'].get('relatedDatasets', [])
            if isinstance(datasets, list):
                dataset_list = []
                for d in datasets:
                    if isinstance(d, dict):
                        dataset_list.append(d.get('relatedDataset', str(d)))
                    elif isinstance(d, str):
                        dataset_list.append(d)
                metadata['relatedDataset'] = '; '.join(dataset_list)
            else:
                metadata['relatedDataset'] = str(datasets)
        if not metadata.get('license'):
            license_obj = dataset_json['data']['latestVersion'].get('license', {})
            if isinstance(license_obj, dict):
                name = license_obj.get('name', '')
                uri = license_obj.get('uri', '')
                if name and uri:
                    metadata['license'] = f"{name} ({uri})"
                elif name:
                    metadata['license'] = name
                elif uri:
                    metadata['license'] = uri
                else:
                    metadata['license'] = str(license_obj)
            elif isinstance(license_obj, str):
                metadata['license'] = license_obj
        files = []
        for f in dataset_json['data']['latestVersion'].get('files', []):
            try:
                fl = {
                    'name': f['dataFile'].get('filename', ''),
                    'type': f['dataFile'].get('contentType', ''),
                    'size': f['dataFile'].get('filesize', ''),
                    'deposit_date': f['dataFile'].get('publicationDate', '')
                }
                if f.get('description'):
                    fl['description'] = f['description']
                else:
                    fl['description'] = ''
                files.append(fl)
            except Exception as ferr:
                logger.warning("File metadata parse issue: %s", ferr)
        metadata['files'] = files
        try:
            user_me_url = build_dataverse_url(dataverse_base_url, '/api/v1/users/:me')
            user_resp = _dataverse_get(user_me_url, headers=headers, timeout=10)
            if user_resp.status_code == 200:
                user_data = user_resp.json()
                data_obj = user_data.get('data') or {}
                first = (data_obj.get('firstName') or '').strip()
                last = (data_obj.get('lastName') or '').strip()
                if first or last:
                    metadata['curator'] = ' '.join(filter(None, [first, last]))
                elif data_obj.get('name'):
                    metadata['curator'] = (data_obj.get('name') or '').strip()
        except Exception as uerr:
            logger.warning(f"Could not fetch curator from /users/:me: {uerr}")
        for block_name in ('geospatial', 'geospatialMetadata'):
            blocks = dataset_json['data']['latestVersion'].get('metadataBlocks') or {}
            if block_name in blocks:
                for gf in blocks[block_name].get('fields', []):
                    try:
                        if gf.get('typeName') == 'geographicCoverage':
                            v = gf.get('value', '')
                            if isinstance(v, list):
                                metadata['geographicCoverage'] = ', '.join([str(x) for x in v])
                            else:
                                metadata['geographicCoverage'] = str(v)
                        if gf.get('typeName') == 'geographicBoundingBox' or 'bounding' in str(gf.get('typeName', '')).lower():
                            v = gf.get('value', '')
                            if isinstance(v, dict):
                                metadata['geographicBoundingBox'] = str(v)
                            else:
                                metadata['geographicBoundingBox'] = str(v) if v else ''
                    except Exception:
                        pass
                break
        if not metadata.get('geographicCoverage'):
            metadata['geographicCoverage'] = metadata.get('geoLocation', '')
        metadata.setdefault('geographicBoundingBox', '')
        metadata['terms'] = metadata.get('license', '')
        session['metadata'] = metadata
        return jsonify(metadata)
    except Exception as e:
        logger.exception("Unexpected error in fetch_dataset_api")
        return jsonify({'error': str(e)}), 500


def _figshare_request_headers(api_key):
    """Build Figshare v2 API headers. Never log the raw key."""
    key = ''.join((api_key or '').strip().split())
    return {
        'Authorization': f'token {key}',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) URGE-FigshareImport/1.0',
    }


def _figshare_strip_description(description_html):
    if not description_html:
        return ''
    try:
        soup = BeautifulSoup(str(description_html), 'html.parser')
        return soup.get_text(separator='\n', strip=True)
    except Exception:
        return str(description_html)


def _map_figshare_article_to_metadata(article_json, files_json):
    """Map Figshare article + files JSON to the same keys used by Dataverse import."""
    meta = {
        'contributors': '',
        'dateCollection': '',
        'relatedDataset': '',
        'dataSources': '',
        'institution': '',
        'email': '',
        'contact_name': '',
        'curator': '',
    }
    meta['title'] = (article_json.get('title') or '').strip() or ''

    meta['description'] = _figshare_strip_description(article_json.get('description'))

    doi_raw = (article_json.get('doi') or '').strip()
    if doi_raw:
        if doi_raw.startswith('http'):
            meta['doi'] = doi_raw
        elif doi_raw.startswith('10.'):
            meta['doi'] = f'https://doi.org/{doi_raw}'
        else:
            meta['doi'] = doi_raw
    else:
        meta['doi'] = ''

    authors = article_json.get('authors') or []
    names = []
    orcid_val = ''
    for author in authors:
        if not isinstance(author, dict):
            continue
        nm = (author.get('full_name') or author.get('name') or '').strip()
        if nm:
            names.append(nm)
        oid = (author.get('orcid_id') or '').strip()
        if oid and not orcid_val:
            orcid_val = oid
    meta['author'] = ', '.join(names)
    meta['orcid'] = orcid_val

    tags = article_json.get('tags') or []
    tag_strs = []
    for t in tags:
        if isinstance(t, str) and t.strip():
            tag_strs.append(t.strip())
        elif isinstance(t, dict):
            tv = (t.get('tag') or t.get('name') or '').strip()
            if tv:
                tag_strs.append(tv)
    meta['keyword'] = ', '.join(tag_strs)

    cats = article_json.get('categories') or []
    cat_titles = []
    for c in cats:
        if isinstance(c, dict):
            ct = (c.get('title') or '').strip()
            if ct:
                cat_titles.append(ct)
        elif isinstance(c, str) and c.strip():
            cat_titles.append(c.strip())
    meta['dataType'] = ', '.join(cat_titles)

    refs = article_json.get('references') or []
    meta['relatedPublication'] = '; '.join(str(r).strip() for r in refs if r)

    funding = article_json.get('funding_list') or article_json.get('funding') or []
    fund_parts = []
    for fund in funding:
        if isinstance(fund, dict):
            part = (fund.get('title') or fund.get('grant_code') or '').strip()
            if part:
                fund_parts.append(part)
        elif fund:
            fund_parts.append(str(fund).strip())
    meta['funding'] = ', '.join(fund_parts)

    lic = article_json.get('license')
    if isinstance(lic, dict):
        name = (lic.get('name') or '').strip()
        uri = (lic.get('url') or lic.get('uri') or '').strip()
        if name and uri:
            meta['license'] = f'{name} ({uri})'
        elif name:
            meta['license'] = name
        elif uri:
            meta['license'] = uri
        else:
            meta['license'] = str(lic)
    elif lic is not None:
        meta['license'] = str(lic).strip()
    else:
        meta['license'] = ''

    geo = article_json.get('geo_location') or article_json.get('geolocation')
    if isinstance(geo, str) and geo.strip():
        meta['geoLocation'] = geo.strip()
    elif isinstance(geo, dict):
        meta['geoLocation'] = ', '.join(f'{k}: {v}' for k, v in geo.items() if v)
    else:
        meta['geoLocation'] = ''

    files_out = []
    for f in files_json or []:
        if not isinstance(f, dict):
            continue
        files_out.append({
            'name': f.get('name', ''),
            'type': f.get('mimetype', '') or '',
            'size': f.get('size', ''),
            'deposit_date': f.get('uploaded_date', '') or f.get('created_date', ''),
            'description': '',
        })
    meta['files'] = files_out

    url_pub = (article_json.get('url_public_html') or '').strip()
    if url_pub and not meta['doi']:
        meta['doi'] = url_pub

    meta['terms'] = meta.get('license', '')
    meta.setdefault('geographicCoverage', meta.get('geoLocation', ''))
    meta.setdefault('geographicBoundingBox', '')
    return meta


@app.route('/fetch_figshare_drafts', methods=['POST'])
def fetch_figshare_drafts():
    """List unpublished (draft) Figshare articles for the authenticated user."""
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', ''))
    masked_ip = _mask_client_ip(client_ip)
    logger.info('fetch_figshare_drafts request (client=%s)', masked_ip)

    try:
        data = request.get_json() or {}
        api_key = data.get('api_key')
        api_key = ''.join((api_key or '').strip().split())
        if not api_key:
            return jsonify({'error': 'API key is required'}), 400

        headers = _figshare_request_headers(api_key)
        drafts = []
        page = 1
        page_size = 100
        max_pages = 50

        while page <= max_pages:
            list_url = (
                f'{FIGSHARE_API_BASE}/v2/account/articles'
                f'?page={page}&page_size={page_size}'
            )
            resp = requests.get(list_url, headers=headers, timeout=30, verify=True)

            if resp.status_code == 401:
                return jsonify({
                    'error': 'Authentication failed',
                    'detail': 'API key is invalid or expired',
                }), 401
            if resp.status_code == 403:
                return jsonify({
                    'error': 'Access denied',
                    'detail': 'You do not have permission to list account articles',
                }), 403
            if resp.status_code != 200:
                detail = resp.text[:500] if resp.text else 'Unknown error'
                try:
                    err_j = resp.json()
                    if isinstance(err_j, dict) and err_j.get('message'):
                        detail = str(err_j['message'])
                except Exception:
                    pass
                return jsonify({
                    'error': f'Failed to fetch articles (HTTP {resp.status_code})',
                    'detail': detail,
                }), resp.status_code if 400 <= resp.status_code < 600 else 502

            try:
                items = resp.json()
            except ValueError:
                return jsonify({'error': 'Invalid response from Figshare API'}), 502

            if not isinstance(items, list):
                return jsonify({'error': 'Unexpected Figshare API response shape'}), 502

            if not items:
                break

            for item in items:
                if not isinstance(item, dict):
                    continue
                pub = item.get('published_date')
                if pub is not None and pub != '' and str(pub).lower() != 'null':
                    continue
                draft_id = item.get('id')
                if draft_id is None:
                    continue
                drafts.append({
                    'id': draft_id,
                    'title': item.get('title') or 'Untitled',
                    'last_update_time': item.get('modified_date') or item.get('created_date') or '',
                    'doi': item.get('doi') or '',
                    'url': item.get('url_public_html') or '',
                })

            if len(items) < page_size:
                break
            page += 1

        return jsonify({'drafts': drafts, 'count': len(drafts)})

    except requests.RequestException as e:
        logger.warning('Figshare drafts request failed: %s', e)
        return jsonify({
            'error': 'Failed to connect to Figshare API',
            'detail': str(e),
        }), 502
    except Exception as e:
        logger.exception('Error in fetch_figshare_drafts')
        return jsonify({'error': str(e)}), 500


@app.route('/fetch_figshare_article', methods=['POST'])
def fetch_figshare_article():
    """Fetch one Figshare article (draft or other) and return normalized metadata."""
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', ''))
    masked_ip = _mask_client_ip(client_ip)
    logger.info('fetch_figshare_article request (client=%s)', masked_ip)

    try:
        data = request.get_json() or {}
        api_key = ''.join((data.get('api_key') or '').strip().split())
        if not api_key:
            return jsonify({'error': 'API key is required'}), 400

        article_id = data.get('article_id')
        try:
            article_id_int = int(article_id)
        except (TypeError, ValueError):
            return jsonify({'error': 'article_id is required and must be an integer'}), 400

        headers = _figshare_request_headers(api_key)
        article_url = f'{FIGSHARE_API_BASE}/v2/account/articles/{article_id_int}'
        files_url = f'{FIGSHARE_API_BASE}/v2/account/articles/{article_id_int}/files'

        art_resp = requests.get(article_url, headers=headers, timeout=30, verify=True)

        if art_resp.status_code == 401:
            return jsonify({
                'error': 'Authentication failed',
                'detail': 'API key is invalid or expired',
            }), 401
        if art_resp.status_code == 403:
            return jsonify({
                'error': 'Access denied',
                'detail': 'You do not have permission to read this article',
            }), 403
        if art_resp.status_code == 404:
            return jsonify({
                'error': 'Article not found',
                'detail': f'No article with id {article_id_int}',
            }), 404
        if art_resp.status_code != 200:
            detail = art_resp.text[:500] if art_resp.text else 'Unknown error'
            return jsonify({
                'error': f'Could not retrieve article (HTTP {art_resp.status_code})',
                'detail': detail,
            }), art_resp.status_code if 400 <= art_resp.status_code < 600 else 502

        try:
            article_json = art_resp.json()
        except ValueError:
            return jsonify({'error': 'Invalid article JSON from Figshare'}), 502

        if not isinstance(article_json, dict):
            return jsonify({'error': 'Unexpected article response from Figshare'}), 502

        files_json = []
        try:
            fil_resp = requests.get(files_url, headers=headers, timeout=30, verify=True)
            if fil_resp.status_code == 200:
                files_json = fil_resp.json()
                if not isinstance(files_json, list):
                    files_json = []
        except requests.RequestException as ferr:
            logger.warning('Figshare files request failed (article_id=%s): %s', article_id_int, ferr)

        metadata = _map_figshare_article_to_metadata(article_json, files_json)
        session['metadata'] = metadata
        return jsonify(metadata)

    except requests.RequestException as e:
        logger.warning('Figshare article request failed: %s', e)
        return jsonify({
            'error': 'Failed to connect to Figshare API',
            'detail': str(e),
        }), 502
    except Exception as e:
        logger.exception('Error in fetch_figshare_article')
        return jsonify({'error': str(e)}), 500


def _figshare_upload_host_allowed(url):
    """Allow only https URLs on figshare.com hosts for outbound upload requests."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    if parsed.scheme != 'https':
        return False
    host = (parsed.hostname or '').lower()
    return host == FIGSHARE_API_HOST or host.endswith('.figshare.com')


@app.route('/send_figshare_readme', methods=['POST'])
def send_figshare_readme():
    """Upload a generated README to a Figshare draft article.

    The Figshare API does not send CORS headers, so the browser cannot talk to
    it directly. This endpoint performs the four-step Figshare upload flow
    (initiate -> read upload URL -> PUT parts -> complete) on the server using
    the caller's personal token. The token is never logged or stored.
    """
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', ''))
    masked_ip = _mask_client_ip(client_ip)
    logger.info('send_figshare_readme request (client=%s)', masked_ip)

    try:
        data = request.get_json() or {}
        api_key = ''.join((data.get('api_key') or '').strip().split())
        if not api_key:
            return jsonify({'error': 'API key is required'}), 400

        try:
            article_id = int(data.get('article_id'))
        except (TypeError, ValueError):
            return jsonify({'error': 'article_id is required and must be an integer'}), 400

        readme_text = data.get('readme_text')
        if not isinstance(readme_text, str) or not readme_text.strip():
            return jsonify({'error': 'readme_text is required'}), 400

        # Guard against unexpectedly large payloads (README files are small).
        readme_bytes = readme_text.encode('utf-8')
        if len(readme_bytes) > 5 * 1024 * 1024:
            return jsonify({'error': 'README is too large to upload'}), 413

        file_name = '00_Readme.txt'
        md5 = hashlib.md5(readme_bytes).hexdigest()
        size = len(readme_bytes)

        headers = _figshare_request_headers(api_key)

        def figshare_get(url):
            return requests.get(url, headers=headers, timeout=30, verify=True)

        # Step 1: initiate the file upload within the article.
        init_url = f'{FIGSHARE_API_BASE}/v2/account/articles/{article_id}/files'
        init_body = {'name': file_name, 'md5': md5, 'size': size}
        init_resp = requests.post(init_url, headers=headers, json=init_body, timeout=30, verify=True)

        if init_resp.status_code == 401:
            return jsonify({'error': 'Authentication failed', 'detail': 'API key is invalid or expired'}), 401
        if init_resp.status_code == 403:
            return jsonify({'error': 'Access denied', 'detail': 'You do not have permission to upload to this article'}), 403
        if init_resp.status_code == 404:
            return jsonify({'error': 'Article not found', 'detail': f'No article with id {article_id}'}), 404
        if init_resp.status_code not in (200, 201):
            detail = init_resp.text[:500] if init_resp.text else 'Unknown error'
            return jsonify({'error': f'Failed to initiate upload (HTTP {init_resp.status_code})', 'detail': detail}), 502

        try:
            location = (init_resp.json() or {}).get('location')
        except ValueError:
            location = None
        if not location or not _figshare_upload_host_allowed(location):
            return jsonify({'error': 'Figshare returned an invalid upload location'}), 502

        # Step 2: read file info to obtain the upload service URL and file id.
        info_resp = figshare_get(location)
        if info_resp.status_code != 200:
            detail = info_resp.text[:500] if info_resp.text else 'Unknown error'
            return jsonify({'error': f'Failed to read file info (HTTP {info_resp.status_code})', 'detail': detail}), 502
        try:
            file_info = info_resp.json()
        except ValueError:
            return jsonify({'error': 'Invalid file info from Figshare'}), 502

        upload_url = file_info.get('upload_url')
        file_id = file_info.get('id')
        if not upload_url or file_id is None or not _figshare_upload_host_allowed(upload_url):
            return jsonify({'error': 'Figshare returned invalid upload details'}), 502

        # Step 3a: read the list of parts from the upload service.
        parts_resp = figshare_get(upload_url)
        if parts_resp.status_code != 200:
            detail = parts_resp.text[:500] if parts_resp.text else 'Unknown error'
            return jsonify({'error': f'Failed to read upload parts (HTTP {parts_resp.status_code})', 'detail': detail}), 502
        try:
            parts = (parts_resp.json() or {}).get('parts') or []
        except ValueError:
            return jsonify({'error': 'Invalid upload parts from Figshare'}), 502
        if not parts:
            return jsonify({'error': 'Figshare returned no upload parts'}), 502

        # Step 3b: upload each part as the corresponding byte range.
        for part in parts:
            try:
                part_no = part['partNo']
                start = int(part['startOffset'])
                end = int(part['endOffset'])
            except (KeyError, TypeError, ValueError):
                return jsonify({'error': 'Malformed upload part from Figshare'}), 502
            chunk = readme_bytes[start:end + 1]
            part_url = f'{upload_url}/{part_no}'
            if not _figshare_upload_host_allowed(part_url):
                return jsonify({'error': 'Figshare returned an invalid part URL'}), 502
            put_resp = requests.put(part_url, data=chunk, timeout=60, verify=True)
            if put_resp.status_code not in (200, 201, 202, 204):
                detail = put_resp.text[:500] if put_resp.text else 'Unknown error'
                return jsonify({'error': f'Failed to upload part {part_no} (HTTP {put_resp.status_code})', 'detail': detail}), 502

        # Step 4: complete the upload.
        complete_url = f'{FIGSHARE_API_BASE}/v2/account/articles/{article_id}/files/{file_id}'
        complete_resp = requests.post(complete_url, headers=headers, timeout=30, verify=True)
        if complete_resp.status_code not in (200, 201, 202, 204):
            detail = complete_resp.text[:500] if complete_resp.text else 'Unknown error'
            return jsonify({'error': f'Failed to complete upload (HTTP {complete_resp.status_code})', 'detail': detail}), 502

        return jsonify({'status': 'OK', 'file_id': file_id, 'name': file_name})

    except requests.RequestException as e:
        logger.warning('Figshare upload request failed: %s', e)
        return jsonify({'error': 'Failed to connect to Figshare API', 'detail': str(e)}), 502
    except Exception:
        logger.exception('Error in send_figshare_readme')
        return jsonify({'error': 'Internal server error'}), 500


def _map_zenodo_deposition_to_metadata(deposition_json):
    """Map Zenodo deposit deposition JSON to the same keys used by Dataverse/Figshare import."""
    meta = {
        'contributors': '',
        'dateCollection': '',
        'relatedDataset': '',
        'dataSources': '',
        'institution': '',
        'email': '',
        'contact_name': '',
        'curator': '',
    }
    if not isinstance(deposition_json, dict):
        return meta

    md = deposition_json.get('metadata') or {}
    if not isinstance(md, dict):
        md = {}

    meta['title'] = (deposition_json.get('title') or md.get('title') or '').strip() or ''

    desc = md.get('description') or ''
    meta['description'] = _figshare_strip_description(desc) if desc else ''

    doi_raw = (deposition_json.get('doi_url') or deposition_json.get('doi') or md.get('doi') or '').strip()
    if not doi_raw and isinstance(md.get('prereserve_doi'), dict):
        pr = md.get('prereserve_doi') or {}
        doi_raw = (pr.get('doi') or '').strip()
    if doi_raw:
        if doi_raw.startswith('http'):
            meta['doi'] = doi_raw
        elif doi_raw.startswith('10.'):
            meta['doi'] = f'https://doi.org/{doi_raw}'
        else:
            meta['doi'] = doi_raw
    else:
        links_doi = deposition_json.get('links') or {}
        html_link = ''
        if isinstance(links_doi, dict):
            html_link = (links_doi.get('latest_draft_html') or links_doi.get('html') or '').strip()
        meta['doi'] = html_link

    creators = md.get('creators') or []
    names = []
    orcid_val = ''
    for c in creators:
        if not isinstance(c, dict):
            continue
        nm = (c.get('name') or '').strip()
        if nm:
            names.append(nm)
        oid = (c.get('orcid') or '').strip()
        if oid and not orcid_val:
            orcid_val = oid.replace('https://orcid.org/', '').replace('http://orcid.org/', '')
    meta['author'] = ', '.join(names)
    meta['orcid'] = orcid_val

    keywords = md.get('keywords') or []
    if isinstance(keywords, list):
        meta['keyword'] = ', '.join(str(k).strip() for k in keywords if str(k).strip())
    else:
        meta['keyword'] = str(keywords).strip() if keywords else ''

    upload_type = (md.get('upload_type') or '').strip()
    pub_type = (md.get('publication_type') or '').strip()
    image_type = (md.get('image_type') or '').strip()
    dtype_parts = [p for p in [upload_type, pub_type, image_type] if p]
    meta['dataType'] = ', '.join(dtype_parts)

    grants = md.get('grants') or []
    fund_parts = []
    for g in grants:
        if isinstance(g, dict) and g.get('id'):
            fund_parts.append(str(g['id']).strip())
        elif g:
            fund_parts.append(str(g).strip())
    meta['funding'] = ', '.join(fund_parts)

    rel_ids = md.get('related_identifiers') or []
    pub_parts = []
    ds_parts = []
    for ri in rel_ids:
        if not isinstance(ri, dict):
            continue
        ident = (ri.get('identifier') or '').strip()
        rel = (ri.get('relation') or '').lower()
        res_type = (ri.get('resource_type') or '').lower()
        if not ident:
            continue
        line = f'{ident} ({rel})' if rel else ident
        rt_dataset = 'dataset' in res_type or (res_type.endswith('dataset') if res_type else False)
        if rt_dataset or 'dataset' in rel:
            ds_parts.append(line)
        else:
            pub_parts.append(line)
    meta['relatedPublication'] = '; '.join(pub_parts)
    meta['relatedDataset'] = '; '.join(ds_parts)

    refs = md.get('references') or []
    if isinstance(refs, list) and refs:
        ref_str = '; '.join(str(r).strip() for r in refs if r)
        if ref_str:
            if meta['relatedPublication']:
                meta['relatedPublication'] = meta['relatedPublication'] + '; ' + ref_str
            else:
                meta['relatedPublication'] = ref_str

    lic = md.get('license')
    meta['license'] = str(lic).strip() if lic else ''

    locations = md.get('locations') or []
    if isinstance(locations, list) and locations:
        loc_strs = []
        for loc in locations:
            if isinstance(loc, dict):
                loc_strs.append(', '.join(f'{k}: {v}' for k, v in loc.items() if v))
        meta['geoLocation'] = '; '.join(loc_strs)
    else:
        meta['geoLocation'] = ''

    dates_meta = md.get('dates') or []
    collected = []
    for d in dates_meta:
        if isinstance(d, dict) and (d.get('type') or '').lower() == 'collected':
            start = d.get('start') or ''
            end = d.get('end') or ''
            span = ' — '.join([p for p in [start, end] if p])
            if span:
                collected.append(span)
    meta['dateCollection'] = ', '.join(collected)

    contributors_md = md.get('contributors') or []
    contrib_names = []
    for c in contributors_md:
        if isinstance(c, dict) and (c.get('name') or '').strip():
            contrib_names.append(c['name'].strip())
    meta['contributors'] = ', '.join(contrib_names)

    files_out = []
    files_raw = deposition_json.get('files') or []
    for f in files_raw:
        if not isinstance(f, dict):
            continue
        fname = f.get('filename') or f.get('key') or f.get('name') or ''
        fsize = f.get('filesize') if f.get('filesize') is not None else f.get('size', '')
        fmt = (f.get('mimetype') or f.get('content_type') or '').strip()
        files_out.append({
            'name': fname,
            'type': fmt,
            'size': fsize,
            'deposit_date': f.get('updated') or f.get('created') or '',
            'description': '',
        })
    meta['files'] = files_out

    meta['terms'] = meta.get('license', '')
    meta.setdefault('geographicCoverage', meta.get('geoLocation', ''))
    meta.setdefault('geographicBoundingBox', '')
    return meta


@app.route('/fetch_zenodo_drafts', methods=['POST'])
def fetch_zenodo_drafts():
    """List draft Zenodo depositions for the authenticated user."""
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', ''))
    masked_ip = _mask_client_ip(client_ip)
    logger.info('fetch_zenodo_drafts request (client=%s)', masked_ip)

    try:
        data = request.get_json() or {}
        access_token = ''.join((data.get('access_token') or '').strip().split())
        if not access_token:
            return jsonify({'error': 'Access token is required'}), 400

        try:
            api_base = normalize_zenodo_api_base_url(data.get('api_base_url'))
        except ValueError as err:
            return jsonify({'error': str(err)}), 400

        headers = _zenodo_request_headers(access_token)
        drafts = []
        page = 1
        page_size = 100
        max_pages = 50

        while page <= max_pages:
            list_url = build_zenodo_deposit_url(
                api_base,
                'api/deposit/depositions',
                query={'status': 'draft', 'size': page_size, 'page': page},
            )
            resp = requests.get(list_url, headers=headers, timeout=30, verify=True)

            if resp.status_code == 401:
                return jsonify({
                    'error': 'Authentication failed',
                    'detail': 'Access token is invalid or expired',
                }), 401
            if resp.status_code == 403:
                return jsonify({
                    'error': 'Access denied',
                    'detail': 'You do not have permission to list depositions',
                }), 403
            if resp.status_code != 200:
                detail = resp.text[:500] if resp.text else 'Unknown error'
                try:
                    err_j = resp.json()
                    if isinstance(err_j, dict) and err_j.get('message'):
                        detail = str(err_j['message'])
                except Exception:
                    pass
                return jsonify({
                    'error': f'Failed to fetch depositions (HTTP {resp.status_code})',
                    'detail': detail,
                }), resp.status_code if 400 <= resp.status_code < 600 else 502

            try:
                payload = resp.json()
            except ValueError:
                return jsonify({'error': 'Invalid response from Zenodo API'}), 502

            items = []
            if isinstance(payload, list):
                items = payload
            elif isinstance(payload, dict):
                hits_obj = payload.get('hits')
                if isinstance(hits_obj, list):
                    items = hits_obj
                elif isinstance(hits_obj, dict) and isinstance(hits_obj.get('hits'), list):
                    items = hits_obj['hits']
                elif isinstance(payload.get('data'), list):
                    items = payload['data']

            if not isinstance(items, list):
                return jsonify({'error': 'Unexpected Zenodo API response shape'}), 502

            if not items:
                break

            for item in items:
                if not isinstance(item, dict):
                    continue
                dep_id = item.get('id')
                if dep_id is None:
                    continue
                md_item = item.get('metadata') if isinstance(item.get('metadata'), dict) else {}
                title = (item.get('title') or md_item.get('title') or '').strip() or 'Untitled'
                modified = item.get('modified') or item.get('created') or ''
                links = item.get('links') or {}
                html_url = ''
                if isinstance(links, dict):
                    html_url = (links.get('html') or links.get('latest_draft_html') or '').strip()
                drafts.append({
                    'id': dep_id,
                    'title': title,
                    'modified': modified,
                    'url': html_url,
                })

            if len(items) < page_size:
                break
            page += 1

        return jsonify({'drafts': drafts, 'count': len(drafts)})

    except requests.RequestException as e:
        logger.warning('Zenodo drafts request failed: %s', e)
        return jsonify({
            'error': 'Failed to connect to Zenodo API',
            'detail': str(e),
        }), 502
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.exception('Error in fetch_zenodo_drafts')
        return jsonify({'error': str(e)}), 500


@app.route('/fetch_zenodo_deposition', methods=['POST'])
def fetch_zenodo_deposition():
    """Fetch one Zenodo draft deposition and return normalized metadata."""
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', ''))
    masked_ip = _mask_client_ip(client_ip)
    logger.info('fetch_zenodo_deposition request (client=%s)', masked_ip)

    try:
        data = request.get_json() or {}
        access_token = ''.join((data.get('access_token') or '').strip().split())
        if not access_token:
            return jsonify({'error': 'Access token is required'}), 400

        try:
            api_base = normalize_zenodo_api_base_url(data.get('api_base_url'))
        except ValueError as err:
            return jsonify({'error': str(err)}), 400

        dep_id = data.get('deposition_id')
        try:
            dep_id_int = int(dep_id)
        except (TypeError, ValueError):
            return jsonify({'error': 'deposition_id is required and must be an integer'}), 400

        headers = _zenodo_request_headers(access_token)
        detail_url = build_zenodo_deposit_url(
            api_base,
            f'api/deposit/depositions/{dep_id_int}',
        )

        dep_resp = requests.get(detail_url, headers=headers, timeout=30, verify=True)

        if dep_resp.status_code == 401:
            return jsonify({
                'error': 'Authentication failed',
                'detail': 'Access token is invalid or expired',
            }), 401
        if dep_resp.status_code == 403:
            return jsonify({
                'error': 'Access denied',
                'detail': 'You do not have permission to read this deposition',
            }), 403
        if dep_resp.status_code == 404:
            return jsonify({
                'error': 'Deposition not found',
                'detail': f'No deposition with id {dep_id_int}',
            }), 404
        if dep_resp.status_code != 200:
            detail = dep_resp.text[:500] if dep_resp.text else 'Unknown error'
            return jsonify({
                'error': f'Could not retrieve deposition (HTTP {dep_resp.status_code})',
                'detail': detail,
            }), dep_resp.status_code if 400 <= dep_resp.status_code < 600 else 502

        try:
            deposition_json = dep_resp.json()
        except ValueError:
            return jsonify({'error': 'Invalid deposition JSON from Zenodo'}), 502

        if not isinstance(deposition_json, dict):
            return jsonify({'error': 'Unexpected deposition response from Zenodo'}), 502

        metadata = _map_zenodo_deposition_to_metadata(deposition_json)
        session['metadata'] = metadata
        return jsonify(metadata)

    except requests.RequestException as e:
        logger.warning('Zenodo deposition request failed: %s', e)
        return jsonify({
            'error': 'Failed to connect to Zenodo API',
            'detail': str(e),
        }), 502
    except Exception as e:
        logger.exception('Error in fetch_zenodo_deposition')
        return jsonify({'error': str(e)}), 500


@app.route('/fetch_user_drafts', methods=['POST'])
def fetch_user_drafts():
    """Fetch the authenticated user's draft datasets."""
    logger.info("fetch_user_drafts request started (%s)", request.method)
    
    try:
        data = request.get_json() or {}
        logger.info("fetch_user_drafts payload received (api_token_present=%s)", bool(data.get('api_token')) if data else False)
        api_token = data.get('api_token') if data else None
        dataverse_base_url_raw = data.get('dataverse_base_url')
        
        if not api_token:
            return jsonify({'error': 'API token is required'}), 400
        
        api_token = api_token.strip()
        api_token = ''.join(api_token.split())
        
        if not api_token:
            return jsonify({'error': 'Invalid API token. The token cannot be empty.'}), 400

        try:
            dataverse_base_url = normalize_dataverse_base_url(dataverse_base_url_raw)
        except ValueError as err:
            return jsonify({'error': str(err)}), 400
        
        user_info_url = build_dataverse_url(dataverse_base_url, '/api/v1/users/:me')
        headers = {
            'X-Dataverse-key': api_token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
        
        username = None
        try:
            user_response = _dataverse_get(user_info_url, headers=headers, timeout=30)
            
            if user_response.status_code == 200:
                try:
                    user_data = user_response.json()
                    if 'data' in user_data:
                        username = user_data['data'].get('user', {}).get('identifier', '')
                        if not username:
                            username = user_data['data'].get('identifier', '')
                except:
                    pass
        except:
            pass
        
        api_urls = []
        if username:
            api_urls.append(build_dataverse_url(dataverse_base_url, f'/api/v1/users/{username}/datasets'))
        
        api_urls.append(build_dataverse_url(dataverse_base_url, '/api/v1/users/:authenticatedUser/datasets'))
        
        response = None
        last_error = None
        
        for api_url in api_urls:
            try:
                response = _dataverse_get(api_url, headers=headers, timeout=30)
                
                if response.status_code == 200:
                    break
                elif response.status_code == 404:
                    continue
            except requests.exceptions.RequestException as e:
                last_error = e
                continue
        
        if response is None:
            return jsonify({
                'error': 'Failed to connect to Dataverse API',
                'detail': str(last_error) if last_error else 'Could not establish connection. The API endpoint may not be available.'
            }), 500
        
        if response.status_code == 401:
            return jsonify({
                'error': 'Authentication failed',
                'detail': 'API token is invalid or expired'
            }), 401
        elif response.status_code == 403:
            return jsonify({
                'error': 'Access denied',
                'detail': 'You do not have permission to access this resource'
            }), 403
        elif response.status_code == 404:
            logger.info(f"404 received, trying Search API endpoint")

            # Search API may ignore state; fetch and filter drafts locally.
            search_urls = [
                build_dataverse_url(dataverse_base_url, '/api/v1/search', urllib.parse.urlencode({'q': '*', 'type': 'dataset', 'per_page': 100})),
                build_dataverse_url(dataverse_base_url, '/api/v1/search', urllib.parse.urlencode({'q': '*', 'type': 'dataset'}))
            ]
            
            response = None
            for search_url in search_urls:
                try:
                    response = _dataverse_get(search_url, headers=headers, timeout=30)
                    
                    if response.status_code == 200:
                        logger.info(f"Search API successful: {search_url}")
                        break
                    elif response.status_code == 404:
                        continue
                except requests.exceptions.RequestException as e:
                    logger.error(f"Search API error: {e}")
                    continue
            
            if response is None or response.status_code != 200:
                logger.warning("All API endpoints failed, returning empty draft list")
                return jsonify({
                    'drafts': [],
                    'count': 0,
                    'message': 'Unable to fetch drafts. The Dataverse API endpoints may not be available or your API token may not have the required permissions.'
                }), 200
        elif response.status_code != 200:
            error_detail = response.text[:500] if response.text else 'Unknown error'
            try:
                error_json = response.json()
                if 'message' in error_json:
                    error_detail = error_json['message']
            except:
                pass
            return jsonify({
                'error': f'Failed to fetch datasets (HTTP {response.status_code})',
                'detail': error_detail
            }), response.status_code
        
        datasets_data = response.json()
        drafts = []
        datasets_list = []

        logger.info("fetch_user_drafts response keys: %s", list(datasets_data.keys()))

        if 'data' in datasets_data:
            if isinstance(datasets_data['data'], list):
                datasets_list = datasets_data['data']
            elif isinstance(datasets_data['data'], dict):
                if 'items' in datasets_data['data']:
                    datasets_list = datasets_data['data']['items']
                elif 'items' in datasets_data:
                    datasets_list = datasets_data['items']

        if not datasets_list and 'items' in datasets_data:
            datasets_list = datasets_data['items']

        if not datasets_list and 'items' in datasets_data.get('data', {}):
            datasets_list = datasets_data['data']['items']

        logger.info("fetch_user_drafts dataset count before filter: %s", len(datasets_list))
        if datasets_list:
            first_dataset = datasets_list[0]
            logger.info(
                "First dataset keys: %s",
                list(first_dataset.keys()) if isinstance(first_dataset, dict) else 'not-a-dict'
            )

        if datasets_list:
            for dataset in datasets_list:
                dataset_obj = dataset
                if isinstance(dataset, dict):
                    if 'dataset' in dataset:
                        dataset_obj = dataset['dataset']
                    elif 'type' in dataset and dataset['type'] == 'dataset':
                        dataset_obj = dataset

                dataset_id = dataset_obj.get('id', '') or dataset_obj.get('global_id', '') or dataset_obj.get('identifier', '')

                latest_version = dataset_obj.get('latestVersion', {})
                version_state = latest_version.get('versionState', '')

                if not version_state:
                    version_state = dataset_obj.get('versionState', '')
                if not version_state:
                    version_state = dataset_obj.get('state', '')
                if not version_state and latest_version:
                    version_state = latest_version.get('state', '')

                if not version_state:
                    if dataset_obj.get('published', False) or dataset_obj.get('isPublished', False):
                        version_state = 'RELEASED'
                    else:
                        version_state = 'DRAFT'

                debug_info = {
                    'id': dataset_id,
                    'versionState_from_latestVersion': latest_version.get('versionState', 'N/A') if latest_version else 'N/A',
                    'versionState_from_dataset': dataset_obj.get('versionState', 'N/A'),
                    'state_from_dataset': dataset_obj.get('state', 'N/A'),
                    'published': dataset_obj.get('published', 'N/A'),
                    'isPublished': dataset_obj.get('isPublished', 'N/A'),
                    'final_version_state': version_state
                }
                logger.debug("Dataset debug fields: %s", debug_info)

                if version_state == 'DRAFT':
                    dataset_id = dataset_obj.get('id', '')

                    protocol = dataset_obj.get('protocol', '')
                    authority = dataset_obj.get('authority', '')
                    identifier = dataset_obj.get('identifier', '')

                    if protocol and authority and identifier:
                        persistent_id = f"{protocol}:{authority}/{identifier}"
                    else:
                        persistent_url = dataset_obj.get('persistentUrl', '')
                        if persistent_url:
                            if 'doi.org/' in persistent_url:
                                persistent_id = persistent_url.split('doi.org/')[-1]
                                persistent_id = f"doi:{persistent_id}"
                            else:
                                persistent_id = persistent_url
                        else:
                            persistent_id = f"dataset_{dataset_id}"

                    title = 'Untitled Dataset'
                    if 'latestVersion' in dataset_obj and 'metadataBlocks' in dataset_obj['latestVersion']:
                        citation_block = dataset_obj['latestVersion'].get('metadataBlocks', {}).get('citation', {})
                        fields = citation_block.get('fields', [])
                        for field in fields:
                            if field.get('typeName') == 'title':
                                title = field.get('value', 'Untitled Dataset')
                                break
                    if title == 'Untitled Dataset' and 'name' in dataset_obj:
                        title = dataset_obj['name']

                    last_update = latest_version.get('lastUpdateTime', '')
                    if not last_update:
                        last_update = dataset_obj.get('publicationDate', '') or dataset_obj.get('modificationTime', '')

                    if persistent_id.startswith('doi:'):
                        doi_url = f"https://doi.org/{persistent_id.replace('doi:', '')}"
                    elif persistent_id.startswith('hdl:'):
                        doi_url = f"https://hdl.handle.net/{persistent_id.replace('hdl:', '')}"
                    else:
                        doi_url = persistent_id
                    
                    drafts.append({
                        'id': dataset_id,
                        'persistent_id': persistent_id,
                        'doi': doi_url,
                        'title': title,
                        'last_update_time': last_update
                    })
        
        return jsonify({
            'drafts': drafts,
            'count': len(drafts)
        })
        
    except requests.RequestException as e:
        return jsonify({
            'error': 'Failed to connect to Dataverse API',
            'detail': str(e)
        }), 500
    except Exception as e:
        logger.exception("Error fetching user drafts")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=not is_production)
