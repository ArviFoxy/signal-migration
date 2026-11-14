//! One lookup of phone numbers at Signal's contact discovery, as the messages exchanged with the enclave.
//!
//! The page carries the messages over a WebSocket and knows nothing of their content. The sequence, as in libsignal's
//! `rust/net/src/cdsi.rs`:
//!
//! 1. The enclave sends its attestation. The client checks it and sends the first handshake message.
//! 2. The enclave answers the handshake. From here on every message is encrypted for the enclave.
//! 3. The client sends the phone numbers. The enclave answers with a token, which stands for the numbers it has now
//!    counted against the account's allowance.
//! 4. The client acknowledges the token. The enclave sends the accounts and closes. Should it send more than one
//!    message, they are merged as protocol buffer messages, as libsignal does: a field in a later message replaces
//!    the same field of an earlier one.

use prost::Message;
use uuid::Uuid;
use wasm_bindgen::prelude::*;

use attest::client_connection::ClientConnection;
use attest::enclave::Handshake;

use crate::{error, time_from_unix_seconds};

/// The client's messages (`rust/net/src/proto/cds2.proto` in libsignal).
#[derive(Clone, PartialEq, Message)]
struct ClientRequest {
    /// Account IDs with their access keys, for accounts the client already knows. Unused here.
    #[prost(bytes = "vec", tag = "1")]
    aci_uak_pairs: Vec<u8>,
    /// Numbers looked up in an earlier request that `token` stands for. Unused here.
    #[prost(bytes = "vec", tag = "2")]
    prev_e164s: Vec<u8>,
    /// The numbers to look up, 8 bytes each.
    #[prost(bytes = "vec", tag = "3")]
    new_e164s: Vec<u8>,
    #[prost(bytes = "vec", tag = "4")]
    discard_e164s: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    token: Vec<u8>,
    #[prost(bool, tag = "7")]
    token_ack: bool,
}

/// The enclave's messages.
#[derive(Clone, PartialEq, Message)]
struct ClientResponse {
    /// One entry of 40 bytes per number: the number (8), its phone number identity (16), its account ID (16).
    #[prost(bytes = "vec", tag = "1")]
    e164_pni_aci_triples: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    token: Vec<u8>,
}

const NUMBER_LENGTH: usize = 8;
const ID_LENGTH: usize = 16;
const ENTRY_LENGTH: usize = NUMBER_LENGTH + 2 * ID_LENGTH;

/// A Signal account that a phone number belongs to.
#[wasm_bindgen(getter_with_clone)]
pub struct DiscoveredAccount {
    /// The phone number as it was asked for, with its leading plus sign.
    #[wasm_bindgen(js_name = phoneNumber)]
    pub phone_number: String,
    /// The account's phone number identity: an ID of the account that is tied to the number.
    #[wasm_bindgen(js_name = phoneNumberIdentity)]
    pub phone_number_identity: String,
    /// The account ID. Contact discovery gives it only to a client that already holds a key of the account.
    #[wasm_bindgen(js_name = accountId)]
    pub account_id: Option<String>,
}

enum Stage {
    AwaitingHandshakeAnswer(Handshake),
    AwaitingToken(ClientConnection),
    AwaitingAccounts(ClientConnection),
    /// A message could not be processed. Nothing more can be done with this lookup.
    Failed,
}

/// One lookup, from the enclave's attestation to the accounts.
#[wasm_bindgen]
pub struct ContactDiscovery {
    stage: Stage,
    numbers: Vec<u64>,
    /// The enclave's messages after the acknowledgement, merged.
    answer: Option<ClientResponse>,
}

/// A phone number as the number contact discovery knows it by: its digits, without the plus sign.
fn digits(phone_number: &str) -> Result<u64, JsError> {
    phone_number
        .strip_prefix('+')
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|digits| digits.parse().ok())
        .ok_or_else(|| {
            error(format!(
                "{phone_number} is not a phone number with a plus sign and digits"
            ))
        })
}

fn id(bytes: &[u8]) -> Option<String> {
    let id = Uuid::from_slice(bytes).expect("an ID has 16 bytes");
    (!id.is_nil()).then(|| id.to_string())
}

impl ContactDiscovery {
    fn new(handshake: Handshake, phone_numbers: Vec<String>) -> Result<ContactDiscovery, JsError> {
        let numbers = phone_numbers
            .iter()
            .map(|number| digits(number))
            .collect::<Result<_, _>>()?;
        Ok(ContactDiscovery {
            stage: Stage::AwaitingHandshakeAnswer(handshake),
            numbers,
            answer: None,
        })
    }

    fn advance(&mut self, message: &[u8]) -> Result<Option<Vec<u8>>, JsError> {
        match std::mem::replace(&mut self.stage, Stage::Failed) {
            Stage::AwaitingHandshakeAnswer(handshake) => {
                let mut connection = handshake.complete(message).map_err(error)?;
                let request = ClientRequest {
                    new_e164s: self.numbers.iter().flat_map(|number| number.to_be_bytes()).collect(),
                    ..Default::default()
                };
                let encrypted = connection.send(&request.encode_to_vec()).map_err(error)?;
                self.stage = Stage::AwaitingToken(connection);
                Ok(Some(encrypted))
            }
            Stage::AwaitingToken(mut connection) => {
                let response = ClientResponse::decode(&*connection.recv(message).map_err(error)?).map_err(error)?;
                if response.token.is_empty() {
                    return Err(error("contact discovery answered the phone numbers without a token"));
                }
                let acknowledgement = ClientRequest {
                    token_ack: true,
                    ..Default::default()
                };
                let encrypted = connection.send(&acknowledgement.encode_to_vec()).map_err(error)?;
                self.stage = Stage::AwaitingAccounts(connection);
                Ok(Some(encrypted))
            }
            Stage::AwaitingAccounts(mut connection) => {
                let part = connection.recv(message).map_err(error)?;
                self.answer
                    .get_or_insert_with(ClientResponse::default)
                    .merge(&*part)
                    .map_err(error)?;
                self.stage = Stage::AwaitingAccounts(connection);
                Ok(None)
            }
            Stage::Failed => Err(error("this lookup has already failed")),
        }
    }
}

#[wasm_bindgen]
impl ContactDiscovery {
    /// Checks the attestation that the enclave sent, as of `unix_seconds`, for the enclave code `enclave_id` names,
    /// and prepares the lookup of `phone_numbers`. Each number has a plus sign and digits.
    pub fn begin(
        enclave_id: &[u8],
        attestation: &[u8],
        unix_seconds: f64,
        phone_numbers: Vec<String>,
    ) -> Result<ContactDiscovery, JsError> {
        let now = time_from_unix_seconds(unix_seconds)?;
        let handshake = attest::cds2::new_handshake(enclave_id, attestation, now).map_err(error)?;
        ContactDiscovery::new(handshake, phone_numbers)
    }

    /// The first message to send to the enclave.
    #[wasm_bindgen(js_name = handshakeMessage)]
    pub fn handshake_message(&self) -> Result<Vec<u8>, JsError> {
        match &self.stage {
            Stage::AwaitingHandshakeAnswer(handshake) => Ok(handshake.initial_request().to_vec()),
            _ => Err(error("the handshake message was already answered")),
        }
    }

    /// Takes the enclave's next message and returns the message to send in answer, if there is one.
    pub fn receive(&mut self, message: &[u8]) -> Result<Option<Vec<u8>>, JsError> {
        self.advance(message)
    }

    /// The accounts found, once the enclave has closed the connection. A number without a Signal account, or whose
    /// owner cannot be found by number, has no entry.
    pub fn accounts(&self) -> Result<Vec<DiscoveredAccount>, JsError> {
        let answer = match (&self.stage, &self.answer) {
            (Stage::AwaitingAccounts(_), Some(answer)) => answer,
            _ => return Err(error("contact discovery closed before it sent the accounts")),
        };
        let entries = &answer.e164_pni_aci_triples;
        if entries.len() % ENTRY_LENGTH != 0 {
            return Err(error(
                "contact discovery sent an answer of a length that is no whole number of entries",
            ));
        }
        Ok(entries
            .chunks_exact(ENTRY_LENGTH)
            .filter_map(|entry| {
                let (number, ids) = entry.split_at(NUMBER_LENGTH);
                let (phone_number_identity, account_id) = ids.split_at(ID_LENGTH);
                let number = u64::from_be_bytes(number.try_into().expect("a number has 8 bytes"));
                Some(DiscoveredAccount {
                    phone_number: format!("+{number}"),
                    phone_number_identity: id(phone_number_identity)?,
                    account_id: id(account_id),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    //! The lookup against a stand-in for the enclave. libsignal's tests come with the attestation of a test enclave
    //! and that enclave's private key, so the stand-in can complete the handshake that the attestation vouches for.

    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    /// The time at which libsignal's tests check the test enclave's attestation (`sgx_session.rs`).
    const ATTESTED_AT: f64 = 1_655_857_680.0;

    /// The enclave's first message (`ClientHandshakeStart` in libsignal's `cds2.proto` of the attest crate).
    #[derive(Clone, PartialEq, Message)]
    struct Attestation {
        #[prost(bytes = "vec", tag = "2")]
        evidence: Vec<u8>,
        #[prost(bytes = "vec", tag = "3")]
        endorsement: Vec<u8>,
    }

    fn test_enclave_id() -> Vec<u8> {
        hex::decode(include_bytes!(
            "../../../third_party/libsignal/rust/attest/tests/data/cds2_test.mrenclave"
        ))
        .expect("the test enclave ID is hexadecimal")
    }

    fn test_attestation() -> Vec<u8> {
        Attestation {
            evidence: include_bytes!("../../../third_party/libsignal/rust/attest/tests/data/cds2_test.evidence")
                .to_vec(),
            endorsement: include_bytes!("../../../third_party/libsignal/rust/attest/tests/data/cds2_test.endorsements")
                .to_vec(),
        }
        .encode_to_vec()
    }

    /// The enclave's side of the channel.
    struct Enclave(snow::TransportState);

    impl Enclave {
        /// Answers the client's handshake message with the test enclave's key.
        fn answering(handshake_message: &[u8]) -> (Enclave, Vec<u8>) {
            let private_key = hex::decode(include_bytes!(
                "../../../third_party/libsignal/rust/attest/tests/data/cds2_test.privatekey"
            ))
            .expect("the test enclave's key is hexadecimal");
            // Contact discovery uses the handshake with a post-quantum key exchange added.
            let pattern = attest::client_connection::NOISE_PATTERN_HFS
                .parse()
                .expect("the pattern parses");
            let mut handshake = snow::Builder::with_resolver(pattern, Box::new(attest::snow_resolver::Resolver))
                .local_private_key(&private_key)
                .expect("the key fits")
                .build_responder()
                .expect("the responder builds");
            handshake
                .read_message(handshake_message, &mut [])
                .expect("the client's handshake message reads");
            let mut answer = vec![0; 4096];
            let length = handshake.write_message(&[], &mut answer).expect("the answer writes");
            answer.truncate(length);
            (
                Enclave(handshake.into_transport_mode().expect("the handshake is finished")),
                answer,
            )
        }

        fn read<M: Message + Default>(&mut self, encrypted: &[u8]) -> M {
            let mut plain = vec![0; encrypted.len()];
            let length = self
                .0
                .read_message(encrypted, &mut plain)
                .expect("the client's message decrypts");
            M::decode(&plain[..length]).expect("the client's message parses")
        }

        fn write(&mut self, message: &impl Message) -> Vec<u8> {
            let plain = message.encode_to_vec();
            let mut encrypted = vec![0; plain.len() + 16];
            let length = self
                .0
                .write_message(&plain, &mut encrypted)
                .expect("the answer encrypts");
            encrypted.truncate(length);
            encrypted
        }
    }

    fn entry(number: u64, phone_number_identity: u128, account_id: u128) -> Vec<u8> {
        [
            &number.to_be_bytes()[..],
            &phone_number_identity.to_be_bytes(),
            &account_id.to_be_bytes(),
        ]
        .concat()
    }

    fn begin(phone_numbers: &[&str]) -> ContactDiscovery {
        ContactDiscovery::begin(
            &test_enclave_id(),
            &test_attestation(),
            ATTESTED_AT,
            phone_numbers.iter().map(|number| number.to_string()).collect(),
        )
        .unwrap_or_else(|_| panic!("the test enclave's attestation is accepted"))
    }

    /// Runs the lookup up to the point where the enclave has the client's acknowledgement.
    fn up_to_acknowledgement(lookup: &mut ContactDiscovery) -> (Enclave, ClientRequest) {
        let (mut enclave, answer) = Enclave::answering(&lookup.handshake_message().ok().expect("a handshake message"));
        let request = lookup
            .receive(&answer)
            .ok()
            .flatten()
            .expect("the phone numbers follow the handshake");
        let request: ClientRequest = enclave.read(&request);
        let token = enclave.write(&ClientResponse {
            token: vec![7, 7, 7],
            ..Default::default()
        });
        let acknowledgement = lookup
            .receive(&token)
            .ok()
            .flatten()
            .expect("an acknowledgement follows the token");
        let acknowledgement: ClientRequest = enclave.read(&acknowledgement);
        assert!(acknowledgement.token_ack, "the token is acknowledged");
        (enclave, request)
    }

    #[wasm_bindgen_test]
    fn a_lookup_sends_the_numbers_and_returns_the_accounts_found() {
        let mut lookup = begin(&["+12025550100", "+447700900101", "+12025550102"]);
        let (mut enclave, request) = up_to_acknowledgement(&mut lookup);

        let asked: Vec<u8> = [12025550100u64, 447700900101, 12025550102]
            .iter()
            .flat_map(|number| number.to_be_bytes())
            .collect();
        assert_eq!(request.new_e164s, asked);
        assert!(!request.token_ack && request.token.is_empty());

        // The second number has no account; the third has one whose account ID the enclave withholds.
        let answer = ClientResponse {
            e164_pni_aci_triples: [
                entry(12025550100, 0x11, 0x22),
                entry(447700900101, 0, 0),
                entry(12025550102, 0x33, 0),
            ]
            .concat(),
            ..Default::default()
        };
        assert!(
            lookup
                .receive(&enclave.write(&answer))
                .ok()
                .expect("the answer is taken")
                .is_none()
        );

        // An ID is written in the form with hyphens.
        let written = |id: u128| Uuid::from_u128(id).to_string();
        let accounts = lookup.accounts().ok().expect("the accounts are there");
        let found: Vec<_> = accounts
            .iter()
            .map(|account| {
                (
                    account.phone_number.clone(),
                    account.phone_number_identity.clone(),
                    account.account_id.clone(),
                )
            })
            .collect();
        assert_eq!(
            found,
            [
                ("+12025550100".to_string(), written(0x11), Some(written(0x22))),
                ("+12025550102".to_string(), written(0x33), None),
            ]
        );
    }

    #[wasm_bindgen_test]
    fn a_connection_that_closes_before_the_accounts_gives_no_result() {
        let mut lookup = begin(&["+12025550100"]);
        up_to_acknowledgement(&mut lookup);
        assert!(lookup.accounts().is_err());
    }

    #[wasm_bindgen_test]
    fn an_answer_without_a_token_ends_the_lookup() {
        let mut lookup = begin(&["+12025550100"]);
        let (mut enclave, answer) = Enclave::answering(&lookup.handshake_message().ok().expect("a handshake message"));
        lookup
            .receive(&answer)
            .ok()
            .flatten()
            .expect("the phone numbers follow the handshake");
        assert!(lookup.receive(&enclave.write(&ClientResponse::default())).is_err());
        assert!(
            lookup.receive(&enclave.write(&ClientResponse::default())).is_err(),
            "and it stays ended"
        );
    }

    #[wasm_bindgen_test]
    fn a_message_the_enclave_did_not_encrypt_ends_the_lookup() {
        let mut lookup = begin(&["+12025550100"]);
        let (_enclave, answer) = Enclave::answering(&lookup.handshake_message().ok().expect("a handshake message"));
        lookup
            .receive(&answer)
            .ok()
            .flatten()
            .expect("the phone numbers follow the handshake");
        assert!(lookup.receive(&[0; 64]).is_err());
    }

    #[wasm_bindgen_test]
    fn a_number_without_plus_sign_and_digits_is_refused() {
        for number in ["12025550100", "+", "+1202 5550100", "+1202x"] {
            let begun = ContactDiscovery::begin(
                &test_enclave_id(),
                &test_attestation(),
                ATTESTED_AT,
                vec![number.into()],
            );
            assert!(begun.is_err(), "{number}");
        }
    }
}
