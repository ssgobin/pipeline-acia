# Pipeline (Bootstrap + Firestore)

Aplicação web simples para gerenciar leads com regra 1‑1‑1 (Status → Feedback → Próxima ação), SLAs por etapa e alerta de prazo total.

## Visão Geral
- SPA estática com Bootstrap 5 e módulos do Firebase carregados via CDN.
- Dados persistidos no Firestore (coleção `leads`).
- Regras automáticas:
  - Status define feedback e próxima ação.
  - Semáforo por etapa (verde/amarelo/vermelho) com base no “Último contato”.
  - Alerta de prazo total se o lead ultrapassar 10 dias desde a criação.
  - Leads atrasados sobem para o topo da lista.

## Funcionalidades
- Cadastro/edição de leads (duplo clique na linha).
- Filtros por Status, Responsável e Segmento + busca.
- Cálculo e exibição do SLA em chips coloridos.
- Alerta agregado de atrasos no topo.

## Executando Localmente
1) Configure o Firebase (seção abaixo).  
2) Abra o arquivo `index.html` em um navegador moderno ou sirva a pasta por um servidor estático (recomendado):

```bash
# Opção Python
python -m http.server 5500
# Acesse: http://localhost:5500/

# Opção Node (http-server)
npx http-server -p 5500
```

## Configuração do Firebase
Edite js/firebase-config.js com as credenciais do seu app Web (Firebase Console → Project settings → Your apps).  
O arquivo já possui um exemplo de estrutura esperada.

Recomendações de regras do Firestore (simplificadas):
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /leads/{id} {
      allow read, write: if request.time < timestamp.date(2030, 1, 1);
    }
  }
}
```
Adapte para o seu cenário restringindo por autenticação quando necessário.

## Esquema de Dados (coleção `leads`)
- Campos principais: `firstName`, `lastName`, `nome`, `company`, `segmento`, `porte`, `tempoAssociacao`, `historicoPatrocinio`, `historico`, `evento`, `cotaIdeal`, `cotaOpcao2`, `cotaOpcao3`, `responsavel`, `status`, `statusKey`, `feedback`, `proximaAcao`, `ultimoContato` (ISO), `contato`, `observacoes`, `createdAt`, `updatedAt`, `createdAtDate` (ISO), `updatedAtDate` (ISO).
- `status` controla `feedback` e `proximaAcao` automaticamente ao salvar e ao ler.
- SLA usa `ultimoContato` (se vazio, `createdAtDate`).

## Atalhos na UI
- Duplo clique em uma linha abre a edição.
- O campo STATUS é editável na tabela; feedback e próxima ação são definidos automaticamente.
- Botão “Recarregar” atualiza a listagem em tempo real.

## Estrutura do Projeto
```
assets/            # logos
css/styles.css     # estilos e chips de SLA
js/app.js          # lógica da aplicação
js/firebase-config.js
index.html         # interface principal
```

## Notas
- As chaves do Firebase em apps Web são públicas por design; proteja dados com regras do Firestore.
- É recomendável servir a aplicação por HTTP local para evitar restrições do navegador ao carregar módulos.

---
Qualquer ajuste fino de regras (novos status, prazos, rótulos) pode ser feito nos pontos listados em “Como Personalizar”.

