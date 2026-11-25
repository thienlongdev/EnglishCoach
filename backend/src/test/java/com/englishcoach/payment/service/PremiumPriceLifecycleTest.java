package com.englishcoach.payment.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.dto.CreatePaymentOrderRequest;
import com.englishcoach.payment.dto.PaymentOrderResponse;
import com.englishcoach.payment.dto.SepayWebhookPayload;
import com.englishcoach.payment.entity.*;
import com.englishcoach.payment.repository.*;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.entity.*;
import com.englishcoach.premium.repository.*;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.springframework.data.jpa.repository.support.JpaRepositoryFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.orm.jpa.*;
import org.springframework.orm.jpa.persistenceunit.PersistenceManagedTypes;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Exercises the real quote, QR, order lock, unique index and subscription write against disposable PostgreSQL. */
class PremiumPriceLifecycleTest {
    @Test
    void migratedCatalogThroughSettlement() throws Exception {
        try (var pg = new PostgreSQLContainer<>("postgres:17")) {
            pg.start();
            HikariConfig cfg = new HikariConfig();
            cfg.setJdbcUrl(pg.getJdbcUrl());
            cfg.setUsername(pg.getUsername());
            cfg.setPassword(pg.getPassword());
            try (var ds = new HikariDataSource(cfg)) {
                var db = new JdbcTemplate(ds);
                db.execute("CREATE TABLE users(id bigint primary key)");
                db.update("INSERT INTO users VALUES (1),(2)");
                Path migrations = Path.of("src/main/resources/db/migration/exams");
                for (String file : List.of("V36__premium_foundation.sql","V37__payment_orders_and_transactions.sql")) {
                    db.execute(Files.readString(migrations.resolve(file)));
                }
                db.execute("""
                    INSERT INTO payment_orders(user_id,plan_id,plan_code_snapshot,plan_name_snapshot,duration_months_snapshot,
                    amount_vnd,transfer_code,expires_at) VALUES (1,1,'PLAN_1_MONTH','Original',1,59000,'ECLEGACY22',now()+interval '20 minutes')
                    """);
                db.execute(Files.readString(migrations.resolve("V132__premium_price_revision.sql")));
                var factory = new LocalContainerEntityManagerFactoryBean();
                factory.setDataSource(ds);
                factory.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
                factory.setManagedTypes(PersistenceManagedTypes.of(User.class.getName(), PremiumPlan.class.getName(),
                        PremiumSubscription.class.getName(), PaymentOrder.class.getName(), PaymentTransaction.class.getName()));
                factory.afterPropertiesSet();
                try {
                    var emf = Objects.requireNonNull(factory.getObject());
                    var txn = new TransactionTemplate(new JpaTransactionManager(emf));
                    EntityManager em = SharedEntityManagerCreator.createSharedEntityManager(emf);
                    var repo = new JpaRepositoryFactory(em);
                    var orders = repo.getRepository(PaymentOrderRepository.class);
                    var transfers = repo.getRepository(PaymentTransactionRepository.class);
                    var plans = repo.getRepository(PremiumPlanRepository.class);
                    var users = mock(UserRepository.class);
                    when(users.findById(1L)).thenAnswer(call -> Optional.of(em.getReference(User.class, 1L)));
                    var subscriptions = new PremiumSubscriptionService(repo.getRepository(PremiumSubscriptionRepository.class),
                            plans, users, new PremiumProperties());
                    var cfgPay = new PaymentProperties();
                    cfgPay.getBank().setBankCode("MB");
                    cfgPay.getBank().setAccountNumber("111");
                    cfgPay.getBank().setAccountName("Test fixture");
                    cfgPay.getSepay().setWebhookSecret("local-fixture");
                    var checkout = new PaymentOrderService(orders, plans, users, cfgPay, new VietQrService(cfgPay), subscriptions);
                    var settle = new PaymentReconciliationService(transfers, orders, subscriptions,
                            mock(NotificationService.class), cfgPay, em);

                    for (var entry : Map.of("PLAN_1_MONTH",89000L,"PLAN_3_MONTHS",239000L,"PLAN_12_MONTHS",749000L).entrySet()) {
                        var request = new CreatePaymentOrderRequest(entry.getKey());
                        var quote = txn.execute(s -> checkout.createPaymentOrder(1L,request));
                        assertThat(quote.getAmountVnd()).isEqualTo(entry.getValue());
                        assertThat(quote.getQrImageUrl()).contains("amount="+entry.getValue()+"&des="+quote.getTransferCode());
                        assertThat(txn.<PaymentOrderResponse>execute(s -> checkout.createPaymentOrder(1L,request)).getOrderId()).isEqualTo(quote.getOrderId());
                        assertThatThrownBy(() -> txn.execute(s -> checkout.getPaymentOrder(2L,quote.getOrderId()))).hasMessageContaining("404");
                    }
                    assertThat(db.queryForObject("SELECT amount_vnd FROM payment_orders WHERE pricing_version=1",Long.class)).isEqualTo(59000L);
                    assertThatThrownBy(() -> db.update("UPDATE payment_orders SET amount_vnd=1 WHERE pricing_version=1")).isInstanceOf(Exception.class);
                    String code = db.queryForObject("SELECT transfer_code FROM payment_orders WHERE duration_months_snapshot=12",String.class);
                    for (long amount : List.of(7490L,749001L)) {
                        var event = transfer(Long.toString(amount),code,amount);
                        assertThat(txn.execute(s -> settle.processWebhook(event,"{}")).getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
                    }
                    var conflict = transfer("200",code,749000);
                    conflict.setContent(code+" ECLEGACY22");
                    assertThat(txn.execute(s -> settle.processWebhook(conflict,"{}")).getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
                    var foreign = transfer("201",code,749000);
                    foreign.setCurrency("USD");
                    assertThat(txn.execute(s -> settle.processWebhook(foreign,"{}")).getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
                    var event = transfer("202",code,749000);
                    db.execute("ALTER TABLE premium_subscriptions ADD CONSTRAINT fixture_failure CHECK(source <> 'SEPAY:202')");
                    assertThatThrownBy(() -> txn.execute(s -> settle.processWebhook(event,"{}"))).isInstanceOf(RuntimeException.class);
                    assertThat(db.queryForObject("SELECT count(*) FROM payment_transactions WHERE provider_transaction_id='202'",Integer.class)).isZero();
                    assertThat(db.queryForObject("SELECT count(*) FROM payment_orders WHERE status='PAID'",Integer.class)).isZero();
                    db.execute("ALTER TABLE premium_subscriptions DROP CONSTRAINT fixture_failure");
                    try (var pool = Executors.newFixedThreadPool(6)) {
                        var start = new CountDownLatch(1);
                        List<Future<?>> copies = new ArrayList<>();
                        for (int i=0; i<6; i++) copies.add(pool.submit(() -> {
                            start.await();
                            txn.execute(s -> settle.processWebhook(event,"{}"));
                            return null;
                        }));
                        start.countDown();
                        for (var copy : copies) copy.get(30,TimeUnit.SECONDS);
                    }
                    assertThat(db.queryForObject("SELECT count(*) FROM premium_subscriptions",Integer.class)).isOne();
                    assertThat(db.queryForObject("SELECT count(*) FROM payment_orders WHERE status='PAID'",Integer.class)).isOne();
                    assertThat(db.queryForObject("SELECT count(*) FROM payment_transactions WHERE provider_transaction_id='202'",Integer.class)).isOne();
                    // A still-valid legacy quote settles independently at the original price and extends the active window.
                    txn.execute(s -> settle.processWebhook(transfer("203","ECLEGACY22",59000),"{}"));
                    assertThat(db.queryForObject("SELECT count(*) FROM premium_subscriptions a JOIN premium_subscriptions b ON a.expires_at=b.starts_at",Integer.class)).isOne();
                } finally {
                    factory.destroy();
                }
            }
        }
    }

    private static SepayWebhookPayload transfer(String id,String reference,long amount) {
        return SepayWebhookPayload.builder().id(id).code(reference).gateway("MB").accountNumber("111")
                .transferType("in").transferAmount(amount).build();
    }

    @Test
    void onlyPlanCodeCanBeSubmitted() {
        var mapper = new ObjectMapper();
        for (String field : List.of("\"amount\":1000","\"amount\":0","\"amount\":-1","\"duration\":120","\"userId\":2")) {
            String body = "{\"planCode\":\"PLAN_1_MONTH\","+field+"}";
            assertThatThrownBy(() -> mapper.readValue(body,CreatePaymentOrderRequest.class)).hasMessageContaining("Only planCode");
        }
    }
}
