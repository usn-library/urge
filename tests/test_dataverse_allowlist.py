"""Dataverse host allow-list (O1) and Stage-0 URL regression tests."""

import os
import unittest
from unittest.mock import MagicMock, patch

import requests

import app as urge_app


# Stage-0 baseline: values returned by normalize_dataverse_base_url /
# build_dataverse_url before the allow-list change, for hosts that remain allowed.
STAGE0_NORMALIZE = {
    None: 'https://dataverse.no',
    '': 'https://dataverse.no',
    '   ': 'https://dataverse.no',
    'https://dataverse.no': 'https://dataverse.no',
    'https://dataverse.no/': 'https://dataverse.no',
    'https://DATAVERSE.NO': 'https://DATAVERSE.NO',
    'https://demo.dataverse.no/': 'https://demo.dataverse.no',
    'dataverse.no': 'https://dataverse.no',
    'https://dataverse.no/foo': 'https://dataverse.no/foo',
    'https://dataverse.no:443': 'https://dataverse.no:443',
}

STAGE0_BUILD = {
    ('https://dataverse.no', '/api/v1/users/:me', ''):
        'https://dataverse.no/api/v1/users/:me',
    (
        'https://dataverse.no',
        '/api/v1/datasets/:persistentId',
        'persistentId=doi%3A10.70122%2FFK2%2FQZXVCS',
    ):
        'https://dataverse.no/api/v1/datasets/:persistentId?persistentId=doi%3A10.70122%2FFK2%2FQZXVCS',
    (
        'https://dataverse.no',
        '/api/datasets/:persistentId/',
        'persistentId=doi%3A10.70122%2FFK2%2FQZXVCS',
    ):
        'https://dataverse.no/api/datasets/:persistentId/?persistentId=doi%3A10.70122%2FFK2%2FQZXVCS',
    ('https://dataverse.no', '/api/v1/users/:authenticatedUser/datasets', ''):
        'https://dataverse.no/api/v1/users/:authenticatedUser/datasets',
    ('https://dataverse.no', '/api/v1', ''):
        'https://dataverse.no/api/v1',
}

DATASET_JSON = {
    'data': {
        'id': 42,
        'persistentUrl': 'https://doi.org/10.70122/FK2/QZXVCS',
        'latestVersion': {
            'metadataBlocks': {
                'citation': {
                    'fields': [
                        {'typeName': 'title', 'value': 'Example dataset'},
                    ]
                }
            },
            'files': [],
            'license': {},
        },
    }
}

DRAFTS_JSON = {
    'data': [
        {
            'id': 42,
            'protocol': 'doi',
            'authority': '10.70122',
            'identifier': 'FK2/QZXVCS',
            'name': 'Example dataset',
            'latestVersion': {
                'versionState': 'DRAFT',
                'lastUpdateTime': '2024-01-01T00:00:00Z',
                'metadataBlocks': {
                    'citation': {
                        'fields': [
                            {'typeName': 'title', 'value': 'Example dataset'},
                        ]
                    }
                },
            },
        }
    ]
}


def _clear_allow_list_env():
    os.environ.pop('URGE_DATAVERSE_ALLOWED_HOSTS', None)


class NormalizeAllowListTests(unittest.TestCase):
    def setUp(self):
        _clear_allow_list_env()

    def tearDown(self):
        _clear_allow_list_env()

    def test_pass_default_hosts(self):
        self.assertEqual(
            urge_app._parse_dataverse_allowed_hosts(),
            frozenset({'dataverse.no', 'demo.dataverse.no'}),
        )
        self.assertEqual(
            urge_app.normalize_dataverse_base_url('https://dataverse.no'),
            'https://dataverse.no',
        )
        self.assertEqual(
            urge_app.normalize_dataverse_base_url('https://demo.dataverse.no/'),
            'https://demo.dataverse.no',
        )
        self.assertEqual(
            urge_app.normalize_dataverse_base_url('https://DATAVERSE.NO'),
            'https://DATAVERSE.NO',
        )

    def test_reject_lookalikes_and_private(self):
        with self.assertRaises(urge_app.DataverseHostNotAllowed):
            urge_app.normalize_dataverse_base_url('https://dataverse.no.attacker.com')
        with self.assertRaises(ValueError):
            urge_app.normalize_dataverse_base_url('https://dataverse.no@attacker.com')
        with self.assertRaises(urge_app.DataverseHostNotAllowed):
            urge_app.normalize_dataverse_base_url('https://attacker.com/dataverse.no')
        with self.assertRaises(ValueError) as http_err:
            urge_app.normalize_dataverse_base_url('http://dataverse.no')
        self.assertNotIsInstance(http_err.exception, urge_app.DataverseHostNotAllowed)
        with self.assertRaises(urge_app.DataverseHostNotAllowed):
            urge_app.normalize_dataverse_base_url('https://xdataverse.no')
        with self.assertRaises(ValueError):
            urge_app.normalize_dataverse_base_url('https://127.0.0.1')

    def test_malformed_env_fails_closed(self):
        os.environ['URGE_DATAVERSE_ALLOWED_HOSTS'] = '@@@not a hostname!!!'
        with self.assertRaises(urge_app.DataverseHostNotAllowed) as ctx:
            urge_app.normalize_dataverse_base_url('https://evil.example')
        self.assertEqual(
            str(ctx.exception),
            'This Dataverse instance is not on the supported list.',
        )
        self.assertNotIn('evil.example', str(ctx.exception))
        self.assertNotIn('dataverse.no', str(ctx.exception))
        self.assertEqual(
            urge_app.normalize_dataverse_base_url('https://dataverse.no'),
            'https://dataverse.no',
        )
        with self.assertRaises(urge_app.DataverseHostNotAllowed):
            urge_app.normalize_dataverse_base_url('https://harvard.dataverse.org')

    def test_env_added_host_passes(self):
        os.environ['URGE_DATAVERSE_ALLOWED_HOSTS'] = 'harvard.dataverse.org'
        self.assertEqual(
            urge_app.normalize_dataverse_base_url('https://harvard.dataverse.org'),
            'https://harvard.dataverse.org',
        )
        self.assertEqual(
            urge_app.normalize_dataverse_base_url('https://dataverse.no'),
            'https://dataverse.no',
        )

    def test_host_not_allowed_is_valueerror(self):
        self.assertTrue(issubclass(urge_app.DataverseHostNotAllowed, ValueError))

    def test_stage0_regression_allowed_hosts(self):
        for raw, expected in STAGE0_NORMALIZE.items():
            self.assertEqual(
                urge_app.normalize_dataverse_base_url(raw),
                expected,
                msg=repr(raw),
            )
        for (base, path, query), expected in STAGE0_BUILD.items():
            self.assertEqual(
                urge_app.build_dataverse_url(base, path, query),
                expected,
            )
        self.assertEqual(
            urge_app.build_dataverse_url('https://dataverse.no', '/api/v1')
            + '/datasets/42/add',
            'https://dataverse.no/api/v1/datasets/42/add',
        )

    def test_dataverse_get_retries_without_verify_on_ssl_error(self):
        calls = []

        def fake_get(url, **kwargs):
            calls.append(kwargs.get('verify'))
            if kwargs.get('verify') is True:
                raise requests.exceptions.SSLError('broken chain')
            return _mock_response(200, {'ok': True})

        with patch('app.requests.get', side_effect=fake_get):
            resp = urge_app._dataverse_get('https://dataverse.no/api/v1/users/:me')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(calls, [True, False])


def _mock_response(status_code, payload):
    resp = MagicMock()
    resp.status_code = 200 if status_code is None else status_code
    resp.json.return_value = payload
    resp.text = ''
    resp.headers = {}
    return resp


def _dataverse_get(url, **kwargs):
    if '/api/v1/users/:me' in url:
        return _mock_response(200, {
            'data': {
                'identifier': 'jdoe',
                'firstName': 'Jane',
                'lastName': 'Doe',
            }
        })
    if '/api/v1/users/jdoe/datasets' in url:
        return _mock_response(200, DRAFTS_JSON)
    if '/api/v1/datasets/:persistentId' in url:
        return _mock_response(200, DATASET_JSON)
    if '/api/datasets/:persistentId' in url:
        return _mock_response(200, DATASET_JSON)
    return _mock_response(404, {'status': 'ERROR'})


class DataverseFlowTests(unittest.TestCase):
    def setUp(self):
        _clear_allow_list_env()
        self.client = urge_app.app.test_client()

    def tearDown(self):
        _clear_allow_list_env()

    @patch('app.requests.get', side_effect=_dataverse_get)
    def test_list_fetch_and_upload_url_sequence(self, mocked_get):
        token = 'test-token-value'
        doi = 'https://doi.org/10.70122/FK2/QZXVCS'
        base = 'https://dataverse.no'

        drafts = self.client.post(
            '/fetch_user_drafts',
            json={'api_token': token, 'dataverse_base_url': base},
        )
        self.assertEqual(drafts.status_code, 200)
        body = drafts.get_json()
        self.assertGreaterEqual(body.get('count', 0), 1)

        meta = self.client.post(
            '/fetch_dataset_api',
            json={'api_token': token, 'doi': doi, 'dataverse_base_url': base},
        )
        self.assertEqual(meta.status_code, 200)
        self.assertEqual(meta.get_json().get('title'), 'Example dataset')

        expected_urls = {
            'https://dataverse.no/api/v1/users/:me',
            'https://dataverse.no/api/v1/users/jdoe/datasets',
            'https://dataverse.no/api/v1/datasets/:persistentId'
            '?persistentId=doi%3A10.70122%2FFK2%2FQZXVCS',
        }
        seen_urls = [call.args[0] for call in mocked_get.call_args_list]
        for url in expected_urls:
            self.assertIn(url, seen_urls)

        for call in mocked_get.call_args_list:
            headers = call.kwargs.get('headers') or {}
            self.assertEqual(headers.get('X-Dataverse-key'), token)

        # README text is generated in the browser; Dataverse upload is
        # browser-direct. The URL that path builds must stay byte-identical.
        upload_url = (
            urge_app.build_dataverse_url(base, '/api/v1') + '/datasets/42/add'
        )
        self.assertEqual(upload_url, 'https://dataverse.no/api/v1/datasets/42/add')

    @patch('app.requests.get', side_effect=_dataverse_get)
    def test_fetch_dataset_api_post_token_in_body_succeeds(self, mocked_get):
        token = 'test-token-value'
        doi = 'https://doi.org/10.70122/FK2/QZXVCS'
        base = 'https://dataverse.no'
        with self.client as client:
            meta = client.post(
                '/fetch_dataset_api',
                json={'api_token': token, 'doi': doi, 'dataverse_base_url': base},
            )
            self.assertEqual(meta.status_code, 200)
            self.assertEqual(meta.get_json().get('title'), 'Example dataset')
            self.assertNotIn('api_token', urge_app.request.args)
            self.assertNotIn(token, urge_app.request.query_string.decode('utf-8'))
            self.assertNotIn(token, urge_app.request.full_path)

    def test_proxy_request_route_removed(self):
        resp = self.client.post(
            '/proxy_request',
            json={'url': 'https://dataverse.no/'},
        )
        self.assertEqual(resp.status_code, 404)

    def test_fetch_dataset_api_get_returns_405(self):
        token = 'must-not-appear-in-logs'
        resp = self.client.get(
            '/fetch_dataset_api'
            f'?doi=10.70122/FK2/QZXVCS&api_token={token}'
            '&dataverse_base_url=https://dataverse.no'
        )
        self.assertEqual(resp.status_code, 405)

    @patch('app.requests.get', side_effect=_dataverse_get)
    def test_fetch_dataset_api_ignores_query_string_token(self, mocked_get):
        body_token = 'body-token-value'
        query_token = 'query-token-value'
        doi = 'https://doi.org/10.70122/FK2/QZXVCS'
        base = 'https://dataverse.no'
        meta = self.client.post(
            f'/fetch_dataset_api?api_token={query_token}&doi={doi}',
            json={'api_token': body_token, 'doi': doi, 'dataverse_base_url': base},
        )
        self.assertEqual(meta.status_code, 200)
        for call in mocked_get.call_args_list:
            headers = call.kwargs.get('headers') or {}
            self.assertEqual(headers.get('X-Dataverse-key'), body_token)
            self.assertNotEqual(headers.get('X-Dataverse-key'), query_token)

    @patch('app.requests.get', side_effect=_dataverse_get)
    def test_fetch_dataset_api_query_only_token_is_rejected(self, mocked_get):
        query_token = 'query-only-token'
        doi = 'https://doi.org/10.70122/FK2/QZXVCS'
        base = 'https://dataverse.no'
        meta = self.client.post(
            f'/fetch_dataset_api?api_token={query_token}&doi={doi}',
            json={'doi': doi, 'dataverse_base_url': base},
        )
        self.assertEqual(meta.status_code, 400)
        mocked_get.assert_not_called()


if __name__ == '__main__':
    unittest.main()
