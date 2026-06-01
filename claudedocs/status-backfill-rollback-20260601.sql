-- 롤백 SQL: status 백필 원복 (user_profiles.status 만 복원, growth_status 무관)
UPDATE user_profiles SET status = 'weekly_rest' WHERE user_id IN ('5fa52ea5-d2a4-45df-900c-e08b0effc2fb', '28c60d60-aa17-4614-9127-fd65a8aebcaf', 'ea286f9d-fb5b-492e-a081-cd5c200a4455');
UPDATE user_profiles SET status = 'graduated' WHERE user_id IN ('4a81b6d1-e488-4f14-8530-0cad60fe4f0d', '63813dc4-9dec-4511-83be-1f54196d09cf', 'e6574586-6279-41cc-ae36-1c9dc3078bc3', '42864260-e4ea-4150-a87f-cff545b02af1', 'e4dcb97e-a515-4ec5-a91e-32ca4e629dae', 'cc1b58e6-b14d-45a0-b389-2df3c27a0b25');
